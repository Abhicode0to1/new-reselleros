/**
 * TDS Receivable — list view of TDS deducted by customers on payments.
 *
 * Each row is one deduction event. Customer pays an invoice → deducts
 * 10% TDS u/s 194J → deposits with govt against your PAN. We track:
 *   1. Pending Form 16A certificate (chase the customer)
 *   2. Certificate received (verify on your Form 26AS)
 *   3. Verified on 26AS (ready to claim in ITR)
 *   4. Claimed in ITR (filed)
 *   5. Disputed (26AS mismatch)
 *
 * Phase 1: view-only list. Action workflows (chase, upload, status
 * transitions) come in Phase 3.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import {
  useTdsReceivables,
  useTdsSummary,
  TDS_STATUSES,
  TDS_STATUS_LABEL,
  TDS_STATUS_DESCRIPTION,
  fiscalYearFromDate,
  type TdsReceivable,
  type TdsStatus,
} from "@/lib/queries/tds-receivable";
import { TdsDetailDialog } from "@/components/features/accounting/tds-detail-dialog";

// ────────────────────────────────────────────────────────────────
// Status color mapping
// ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<TdsStatus, "rose" | "emerald" | "amber" | "slate" | "indigo"> = {
  pending_cert:  "rose",
  cert_received: "amber",
  verified_26as: "emerald",
  claimed:       "indigo",
  disputed:      "rose",
  written_off:   "slate",
};

// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────

export default function TdsReceivablePage() {
  const currentFY = fiscalYearFromDate(new Date().toISOString().slice(0, 10));
  const [fy, setFy] = React.useState<string>(currentFY);
  const [activeTab, setActiveTab] = React.useState<TdsStatus | "all">("all");
  const [selected, setSelected]   = React.useState<TdsReceivable | null>(null);

  const summaryQ = useTdsSummary(fy);
  const listQ    = useTdsReceivables({
    fiscalYear: fy,
    status: activeTab,
  });

  const rows    = listQ.data    ?? [];
  const summary = summaryQ.data;

  // FY picker options — current + 2 prev
  const fyOptions = React.useMemo(() => {
    const cur = parseInt(currentFY.slice(2, 4), 10);
    return [0, 1, 2, 3, 4].map((offset) => {
      const start = cur - offset;
      return `FY${String(start).padStart(2, "0")}${String(start + 1).padStart(2, "0")}`;
    });
  }, [currentFY]);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">TDS Receivable</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            TDS your B2B customers deducted before paying invoices. Each entry
            travels through the lifecycle below until you claim it in your ITR.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">
            Fiscal year
          </label>
          <select
            value={fy}
            onChange={(e) => setFy(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper font-mono"
          >
            {fyOptions.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <Link
            href={`/accounting/tds-receivable/year-end?fy=${fy}`}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-hairline text-ink-3 hover:text-ink hover:bg-paper-2 transition-colors"
          >
            <Icon name="trending_up" size={12} />
            Year-end summary
          </Link>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-6">
        <KPI
          label={`Total TDS · ${fy}`}
          value={summary ? rupee(summary.totalAmount) : "—"}
          hint={summary ? `${summary.totalCount} entries` : ""}
          big
        />
        <KPI
          label="Pending certificate"
          value={summary ? rupee(summary.byStatus.pending_cert.amount) : "—"}
          hint={summary ? `${summary.byStatus.pending_cert.count} chase items` : ""}
          tone="rose"
        />
        <KPI
          label="Ready to claim in ITR"
          value={summary ? rupee(summary.claimableAmount) : "—"}
          hint="Cert + 26AS verified"
          tone="emerald"
        />
        <KPI
          label="Already claimed"
          value={summary ? rupee(summary.byStatus.claimed.amount) : "—"}
          hint={summary ? `${summary.byStatus.claimed.count} filed` : ""}
          tone="indigo"
        />
      </div>

      {/* Lifecycle education banner (only when empty) */}
      {summary && summary.totalCount === 0 && (
        <Card className="p-5 mb-6 bg-paper-2/30">
          <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
            <Icon name="info" size={12} className="text-indigo inline mr-1 align-text-bottom" />
            How TDS Receivable works
          </div>
          <div className="text-sm text-ink-2 leading-relaxed space-y-2">
            <p>
              B2B customers (Pvt Ltd, LLPs, large firms) deduct TDS @ 10% u/s 194J
              before paying your invoice. You receive less than billed but the deducted
              amount is deposited with govt against your PAN.
            </p>
            <p>
              TDS entries get auto-created from the <Link href="/payments" className="text-amber-ink underline">Record Payment</Link> dialog
              when you check &quot;TDS was deducted&quot;. Each entry travels through:
              <span className="font-mono text-xs mt-1 block bg-paper px-2 py-1 rounded">
                Pending cert → Cert received → Verified on 26AS → Claimed in ITR
              </span>
            </p>
            <p className="text-ink-3 text-xs italic">
              Phase 2 (Record Payment integration) coming next — for now this page is view-only.
            </p>
          </div>
        </Card>
      )}

      {/* Tabs */}
      <div className="mb-5 flex flex-wrap gap-1.5">
        <TabButton
          label="All"
          active={activeTab === "all"}
          count={summary?.totalCount ?? 0}
          onClick={() => setActiveTab("all")}
        />
        {TDS_STATUSES.map((s) => (
          <TabButton
            key={s}
            label={TDS_STATUS_LABEL[s]}
            active={activeTab === s}
            count={summary?.byStatus[s].count ?? 0}
            tone={STATUS_COLOR[s]}
            onClick={() => setActiveTab(s)}
          />
        ))}
      </div>

      {/* Active tab description */}
      {activeTab !== "all" && (
        <div className="text-xs text-ink-3 mb-4 italic">
          {TDS_STATUS_DESCRIPTION[activeTab]}
        </div>
      )}

      {/* List */}
      {listQ.isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="receipt"
            title={activeTab === "all" ? "No TDS entries yet" : `No entries in "${TDS_STATUS_LABEL[activeTab as TdsStatus]}"`}
            body={activeTab === "all"
              ? "TDS entries will appear here when customers deduct tax on payments. Wait for Phase 2 (Record Payment integration) — or add manually for past invoices."
              : "Switch to a different tab or fiscal year."}
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-3">Date</th>
                  <th className="text-left  px-4 py-3">Customer</th>
                  <th className="text-left  px-4 py-3">TAN</th>
                  <th className="text-left  px-4 py-3">Section</th>
                  <th className="text-right px-4 py-3">Gross</th>
                  <th className="text-right px-4 py-3">TDS</th>
                  <th className="text-right px-4 py-3">Rate</th>
                  <th className="text-left  px-4 py-3">Status</th>
                  <th className="text-left  px-4 py-3">Invoice</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="hover:bg-paper-2/40 cursor-pointer"
                    onClick={() => setSelected(r)}
                  >
                    <td className="px-4 py-3 text-ink-2">{formatDate(r.payment_received_date)}</td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-ink hover:text-amber-ink">{r.customer_name}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-3">{r.customer_tan ?? "—"}</td>
                    <td className="px-4 py-3 text-ink-2 font-mono text-xs">{r.section}</td>
                    <td className="px-4 py-3 text-right text-ink-2 font-mono">{rupee(r.gross_amount)}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-rose">{rupee(r.tds_amount)}</td>
                    <td className="px-4 py-3 text-right text-ink-3 font-mono">{Number(r.rate_pct).toFixed(2)}%</td>
                    <td className="px-4 py-3">
                      <Badge color={STATUS_COLOR[r.status]}>{TDS_STATUS_LABEL[r.status]}</Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {r.invoice_id ? (
                        <span className="text-amber-ink">{r.invoice_id}</span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Mobile cards */}
          <ul className="md:hidden space-y-2.5">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelected(r)}
                  className="w-full text-left"
                >
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <div className="font-medium text-ink leading-tight">{r.customer_name}</div>
                        <div className="text-2xs text-ink-3 mt-0.5">
                          {formatDate(r.payment_received_date)} · {r.section} @ {Number(r.rate_pct).toFixed(2)}%
                        </div>
                      </div>
                      <Badge color={STATUS_COLOR[r.status]}>{TDS_STATUS_LABEL[r.status]}</Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-2xs">
                      <div>
                        <div className="text-ink-3 uppercase tracking-wider">Gross</div>
                        <div className="font-mono text-ink">{rupee(r.gross_amount)}</div>
                      </div>
                      <div>
                        <div className="text-ink-3 uppercase tracking-wider">TDS</div>
                        <div className="font-mono font-semibold text-rose">{rupee(r.tds_amount)}</div>
                      </div>
                    </div>
                    {r.customer_tan && (
                      <div className="text-3xs text-ink-3 mt-2 font-mono">TAN: {r.customer_tan}</div>
                    )}
                  </Card>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Detail dialog */}
      <TdsDetailDialog
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
        tds={selected}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────

function TabButton({
  label, active, count, tone, onClick,
}: {
  label: string;
  active: boolean;
  count: number;
  tone?: "rose" | "emerald" | "amber" | "slate" | "indigo";
  onClick: () => void;
}) {
  const dotColor = tone === "rose"    ? "bg-rose"
                 : tone === "emerald" ? "bg-emerald"
                 : tone === "amber"   ? "bg-amber"
                 : tone === "indigo"  ? "bg-indigo"
                 : tone === "slate"   ? "bg-slate"
                 :                      "bg-ink-3";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border transition-colors ${
        active
          ? "border-amber bg-amber-soft text-amber-ink font-semibold"
          : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
      }`}
    >
      {tone && <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />}
      {label}
      <span className={`text-3xs px-1.5 py-0.5 rounded ${active ? "bg-paper text-amber-ink" : "bg-paper-2 text-ink-3"}`}>
        {count}
      </span>
    </button>
  );
}

function KPI({
  label, value, hint, tone, big,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "emerald" | "rose" | "amber" | "indigo";
  big?: boolean;
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : tone === "amber"   ? "text-amber-ink"
                   : tone === "indigo"  ? "text-indigo"
                   : "text-ink";
  return (
    <Card className="p-3 md:p-4">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif ${big ? "text-2xl md:text-3xl" : "text-xl md:text-2xl"} ${colorClass} leading-tight`}>
        {value}
      </div>
      {hint && <div className="text-3xs text-ink-3 mt-1">{hint}</div>}
    </Card>
  );
}
