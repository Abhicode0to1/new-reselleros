/**
 * Payments Made — consolidated feed of money paid to vendors (against bills).
 * The purchase-side mirror of Sales → Payments. Read-only; record a payment
 * from Vendor Bills → Record payment.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { rupee, formatDate } from "@/lib/utils";
import { useBillPayments } from "@/lib/queries/bill-payments";

function isThisMonthIST(dateStr: string): boolean {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const d = new Date(dateStr);
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
}

export default function BillPaymentsPage() {
  const { data: payments, isLoading, error } = useBillPayments();

  const rows = payments ?? [];
  const totalAll = rows.reduce((s, p) => s + p.amount, 0);
  const totalMtd = rows.filter((p) => isThisMonthIST(p.txn_date)).reduce((s, p) => s + p.amount, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Payments Made</h1>
        <p className="text-sm text-ink-3 mt-1">
          Money paid to vendors against bills. To record a new payment, open a bill in{" "}
          <Link href="/accounting/bills" className="text-amber hover:underline">Vendor Bills</Link>{" "}
          → Record payment.
        </p>
      </div>

      {/* KPI strip */}
      {!isLoading && rows.length > 0 && (
        <Card className="mb-6">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Paid · this month</p>
              <p className="font-serif text-2xl text-ink mt-1">{rupee(totalMtd, { compact: true })}</p>
            </div>
            <div>
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Paid · all time</p>
              <p className="font-serif text-2xl text-ink mt-1">{rupee(totalAll, { compact: true })}</p>
            </div>
            <div>
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Payments</p>
              <p className="font-serif text-2xl text-ink mt-1">{rows.length}</p>
            </div>
          </div>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
      ) : error ? (
        <Card><p className="text-sm text-rose">Couldn&apos;t load payments. Please refresh.</p></Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="rupee"
            title="No vendor payments yet."
            body="When you pay a vendor bill (Vendor Bills → Record payment), it appears here as a consolidated feed of money paid out."
          />
        </Card>
      ) : (
        <>
          {/* Mobile cards */}
          <ul className="md:hidden space-y-2">
            {rows.map((p) => (
              <li key={p.id} className="rounded-lg border border-hairline bg-paper p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink truncate">{p.vendor_name}</span>
                  <span className="font-serif tabular-nums text-rose">− {rupee(p.amount)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-2xs text-ink-3">
                  <span>{formatDate(p.txn_date)}</span>
                  {p.method && <span className="capitalize">· {p.method}</span>}
                  <span>· {p.bank_account_name}</span>
                  {p.bill_no && <span className="font-mono">· {p.bill_no}</span>}
                </div>
              </li>
            ))}
          </ul>

          {/* Desktop table */}
          <Card className="hidden md:block p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper-2 border-b border-hairline">
                  <tr className="text-left text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                    <th className="p-3">Date</th>
                    <th className="p-3">Vendor</th>
                    <th className="p-3">Bill #</th>
                    <th className="p-3">Method</th>
                    <th className="p-3">Paid from</th>
                    <th className="p-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                      <td className="p-3 whitespace-nowrap text-ink-2">{formatDate(p.txn_date)}</td>
                      <td className="p-3 font-medium text-ink">{p.vendor_name}</td>
                      <td className="p-3 font-mono text-2xs text-ink-3">{p.bill_no ?? "—"}</td>
                      <td className="p-3 capitalize text-ink-2">{p.method ?? "—"}</td>
                      <td className="p-3 text-ink-2">{p.bank_account_name}</td>
                      <td className="p-3 text-right font-serif tabular-nums text-rose">− {rupee(p.amount)}</td>
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
