/**
 * CashFlowMonthSheet — the bank lines behind one month's row on Cash Flow.
 *
 * Opens on "Cash out" (where did the money go?), with "Cash in" one tab away.
 * A by-label summary on top says where it went; each line opens that line on its
 * bank account, where an unreconciled one can be reconciled. The totals are summed
 * from the same lines as the row, so the sheet and the row cannot disagree.
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
} from "@/components/ui/sheet";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { lineLabel, totalsByLabel, NOT_RECONCILED, type CashFlowTxn } from "@/lib/accounting/cash-flow-lines";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "Sept 26" */
  monthLabel: string;
  lines: CashFlowTxn[];
  accountName: (id: string) => string;
}

export function CashFlowMonthSheet({ open, onOpenChange, monthLabel, lines, accountName }: Props) {
  const [side, setSide] = React.useState<"out" | "in">("out");
  const [sort, setSort] = React.useState<"amount" | "date">("amount");
  React.useEffect(() => { if (open) { setSide("out"); setSort("amount"); } }, [open, monthLabel]);

  const outLines = lines.filter((l) => l.debit > 0);
  const inLines  = lines.filter((l) => l.credit > 0);
  const shown = (side === "out" ? outLines : inLines).slice().sort((a, b) =>
    sort === "amount"
      ? (side === "out" ? b.debit - a.debit : b.credit - a.credit)
      : b.txn_date.localeCompare(a.txn_date));
  const total = shown.reduce((s, l) => s + (side === "out" ? l.debit : l.credit), 0);
  const groups = totalsByLabel(lines, side);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[600px] md:max-w-[680px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>{monthLabel} — bank lines</SheetTitle>
          <SheetDescription>
            Every bank debit and credit behind this month&apos;s row. Click a line to open it on its bank
            account — unreconciled ones can be reconciled there.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Out / In */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex gap-1.5" role="tablist" aria-label="Direction">
              {([["out", `Cash out (${outLines.length})`], ["in", `Cash in (${inLines.length})`]] as const).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={side === k}
                  onClick={() => setSide(k)}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${side === k ? "bg-ink text-paper border-ink" : "border-hairline text-ink-2 hover:bg-paper-2"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="text-2xs text-ink-3 flex items-center gap-1.5">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as "amount" | "date")}
                className="rounded border border-hairline bg-paper px-1.5 py-0.5 text-2xs text-ink"
              >
                <option value="amount">Biggest first</option>
                <option value="date">Newest first</option>
              </select>
            </label>
          </div>

          {/* Where it went / came from */}
          {groups.length > 0 && (
            <div className="rounded-md border border-hairline bg-paper-2/30 p-3">
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
                {side === "out" ? "Where it went" : "Where it came from"}
              </p>
              <ul className="space-y-1">
                {groups.map((g) => (
                  <li key={g.label} className="flex items-center justify-between gap-2 text-xs">
                    <span className={g.label === NOT_RECONCILED ? "text-amber-ink font-medium" : "text-ink-2"}>
                      {g.label} <span className="text-ink-3">· {g.count}</span>
                    </span>
                    <span className="tabular-nums text-ink">{rupee(g.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* The lines */}
          {shown.length === 0 ? (
            <p className="text-sm text-ink-3">No {side === "out" ? "money out" : "money in"} this month.</p>
          ) : (
            <ul className="divide-y divide-hairline rounded-md border border-hairline">
              {shown.map((l) => {
                const label = lineLabel(l);
                const amt = side === "out" ? l.debit : l.credit;
                return (
                  <li key={l.id}>
                    <Link
                      href={`/accounting/banking/${l.bank_account_id}?focus=${l.id}` as never}
                      className="flex items-start gap-3 px-3 py-2.5 hover:bg-paper-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] text-ink truncate" title={l.description ?? ""}>{l.description || "—"}</p>
                        <p className="text-3xs text-ink-3 mt-0.5">
                          {formatDate(l.txn_date)} · {accountName(l.bank_account_id)} ·{" "}
                          <span className={label === NOT_RECONCILED ? "text-amber-ink font-medium" : ""}>{label}</span>
                        </p>
                      </div>
                      <span className={`text-[12px] font-semibold tabular-nums shrink-0 ${side === "out" ? "text-rose" : "text-emerald"}`}>
                        {rupee(amt)}
                      </span>
                      <Icon name="chevron_right" size={14} className="text-ink-3 shrink-0 mt-0.5" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          {shown.length > 0 && (
            <div className="flex justify-between border-t-2 border-ink pt-2 text-sm font-semibold">
              <span>Total {side === "out" ? "cash out" : "cash in"}</span>
              <span className="tabular-nums">{rupee(total)}</span>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
