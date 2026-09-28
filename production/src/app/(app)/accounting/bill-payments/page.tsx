/**
 * Payments Made — every rupee that left the bank, the mirror of Payments Received:
 * vendors & expenses, salaries, statutory & tax challans, advances & commissions,
 * capital / loans — from the reconciled bank lines (lib/accounting/payments-made.ts).
 * Read-only; money is recorded where it happens (Bills, Expenses, Payroll, Banking).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/shared/empty-state";
import { TabBar } from "@/components/ui/tabs";
import { rupee, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { useMoneyOut } from "@/lib/queries/payments-made";
import { summarisePaidOut, paidOutCsvRows, PAID_OUT_CSV_HEADERS, GROUP_LABEL, type PaidGroup } from "@/lib/accounting/payments-made";

type Tab = "all" | PaidGroup;
const TABS: Tab[] = ["all", "vendors", "salaries", "statutory", "advances", "other", "unreconciled"];
function todayIso(): string { return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10); }

export default function PaymentsMadePage() {
  const { data, isLoading, error } = useMoneyOut();
  const [tab, setTab] = React.useState<Tab>("all");
  const [q, setQ] = React.useState("");
  /* Analytics card folds like the one on Payments Received; the choice is remembered per browser. */
  const [analyticsOpen, setAnalyticsOpen] = React.useState(true);
  React.useEffect(() => { try { setAnalyticsOpen(localStorage.getItem("ros.paymentsMade.analytics") !== "closed"); } catch { /* private mode */ } }, []);
  const toggleAnalytics = () => setAnalyticsOpen((v) => { try { localStorage.setItem("ros.paymentsMade.analytics", v ? "closed" : "open"); } catch { /* ignore */ } return !v; });
  const lines = React.useMemo(() => data ?? [], [data]);
  const summary = React.useMemo(() => summarisePaidOut(lines, todayIso()), [lines]);
  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lines
      .filter((l) => tab === "all" || l.group === tab)
      .filter((l) => !needle || [l.payee, l.what, l.reference ?? "", l.description ?? "", l.account].some((s) => s.toLowerCase().includes(needle)));
  }, [lines, tab, q]);
  const shown = rows.reduce((s, l) => s + l.amount, 0);
  const countOf = (g: Tab) => (g === "all" ? lines.length : lines.filter((l) => l.group === g).length);

  const exportCsv = () => downloadCSV(`payments-made-${tab}-${todayIso()}.csv`, PAID_OUT_CSV_HEADERS, paidOutCsvRows(rows));

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-5 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Payments Made</h1>
          <p className="text-sm text-ink-3 mt-1">Har paisa jo bank se nikla — vendors, salaries, tax/challan, advances · bank lines se, jaise reconcile hui waise</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="default" icon="download" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</Button>
          <Link href={"/accounting/bills" as Route}><Button variant="primary" icon="file">View Bills →</Button></Link>
        </div>
      </div>


      {/* Analytics strip — the mirror of "Payments & Collections Analytics" */}
      {!isLoading && lines.length > 0 && (
        <Card className="mb-4 p-3 md:p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs font-semibold text-ink-2 font-mono">
              Payments &amp; Outflow Analytics
              {!analyticsOpen && <span className="font-normal text-ink-3"> · Paid MTD: <b className="text-rose">{rupee(summary.mtd)}</b> · This FY: <b className="text-ink">{rupee(summary.fy)}</b> · Awaiting reconcile: {summary.unreconciled.count}</span>}
            </p>
            <button type="button" onClick={toggleAnalytics} aria-expanded={analyticsOpen} className="text-xs font-semibold text-amber-ink hover:underline inline-flex items-center gap-1">
              {analyticsOpen ? "Collapse" : "Expand"} <Icon name={analyticsOpen ? "chevron_up" : "chevron_down"} size={13} />
            </button>
          </div>
          {analyticsOpen && (<>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
            <div className="rounded-md border border-hairline p-3"><p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Paid MTD</p><p className="font-serif text-2xl text-rose mt-1">{rupee(summary.mtd)}</p></div>
            <div className="rounded-md border border-hairline p-3"><p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Paid this FY</p><p className="font-serif text-2xl text-ink mt-1">{rupee(summary.fy)}</p></div>
            <div className="rounded-md border border-hairline p-3"><p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Awaiting reconcile</p><p className={`font-serif text-2xl mt-1 ${summary.unreconciled.count ? "text-amber-ink" : "text-emerald"}`}>{rupee(summary.unreconciled.amount)} <span className="text-xs font-sans text-ink-3">({summary.unreconciled.count})</span></p></div>
            <div className="rounded-md border border-hairline p-3"><p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Top payee</p><p className="font-serif text-lg text-ink mt-1 truncate">{summary.topPayee ? `${summary.topPayee.name}` : "—"}</p>{summary.topPayee && <p className="text-xs text-ink-3">{rupee(summary.topPayee.amount)} all-time</p>}</div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
            {summary.byGroup.map((g) => <span key={g.group}>{g.label} <b className="text-ink-2">{rupee(g.amount)}</b> ({g.count})</span>)}
          </div>
          </>)}
        </Card>
      )}

      {/* Tabs + search stay pinned under the top bar (h-14) while the list scrolls. */}
      <div className="sticky top-14 z-20 -mx-4 md:-mx-6 lg:-mx-8 px-4 md:px-6 lg:px-8 pt-2 pb-1 bg-paper/95 backdrop-blur-sm border-b border-hairline">
      <TabBar
        className="overflow-y-hidden mb-3"
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        items={TABS.map((t) => ({ id: t, label: t === "all" ? "All payments" : GROUP_LABEL[t], count: countOf(t) || undefined, dot: t === "unreconciled" && countOf(t) ? "rose" : undefined }))}
      />
      <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-ink-3">Showing {rows.length} of {lines.length} payments · <b className="text-ink">{rupee(shown)}</b>{tab === "all" ? ` · ${rupee(summary.allTime)} paid all-time` : ""}</p>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Payee, what, bill no., narration…" className="w-full sm:w-80" aria-label="Search payments" />
      </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
      ) : error ? (
        <Card><p className="text-sm text-rose">Couldn&apos;t load payments. Please refresh.</p></Card>
      ) : rows.length === 0 ? (
        <Card><EmptyState icon="rupee" title={lines.length ? "Is tab / search mein kuch nahi" : "Koi payment nahi"} body="Bank statement import karo aur lines reconcile karo — har money-out yahan aa jayega." /></Card>
      ) : (
        <>
          <ul className="md:hidden space-y-2">
            {rows.map((l) => (
              <li key={l.id} className="rounded-lg border border-hairline bg-paper p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink truncate">{l.payee}</span>
                  <span className="font-serif tabular-nums text-rose">− {rupee(l.amount)}</span>
                </div>
                <div className="mt-1 text-xs text-ink-3">{formatDate(l.txn_date)} · {l.what}{l.reference ? ` · ${l.reference}` : ""} · {l.account}</div>
                {l.group === "unreconciled" && <Link href={"/accounting/banking" as Route} className="text-xs text-amber-ink underline">Reconcile →</Link>}
              </li>
            ))}
          </ul>
          <Card className="hidden md:block p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper-2 border-b border-hairline">
                  <tr className="text-left text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                    <th className="p-3">Date</th><th className="p-3">Paid to</th><th className="p-3">What</th><th className="p-3">Ref</th><th className="p-3">Paid from</th><th className="p-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.id} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                      <td className="p-3 whitespace-nowrap text-ink-2">{formatDate(l.txn_date)}</td>
                      <td className="p-3 font-medium text-ink">{l.payee}</td>
                      <td className="p-3 text-ink-2">{l.group === "unreconciled" ? <Link href={"/accounting/banking" as Route} className="text-amber-ink underline">Not reconciled — book it →</Link> : l.what}</td>
                      <td className="p-3 font-mono text-xs text-ink-3">{l.reference ?? "—"}</td>
                      <td className="p-3 text-ink-2">{l.account}</td>
                      <td className="p-3 text-right font-serif tabular-nums text-rose">− {rupee(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
