/**
 * Customer Aging — outstanding receivables bucketed by days overdue.
 *
 * Buckets (from invoice date):
 *   • Current      0–30 days
 *   • 31–60 days
 *   • 61–90 days
 *   • 90+ days     (worst)
 *
 * Per customer: shows outstanding in each bucket + total + days of oldest
 * invoice. Sorted by total outstanding descending so the biggest exposure
 * is at the top.
 *
 * Inline WhatsApp / Email actions per customer for quick follow-up.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";

// ────────────────────────────────────────────────────────────────
// Aggregation hook
// ────────────────────────────────────────────────────────────────

interface CustomerAgingRow {
  customerId:      string | null;
  customerName:    string;
  contactEmail:    string | null;
  contactPhone:    string | null;
  buckets:         { current: number; b30: number; b60: number; b90: number; over90: number };
  total:           number;
  oldestDays:      number;
  oldestInvoiceId: string | null;
}

interface AgingTotals {
  current: number;
  b30:     number;
  b60:     number;
  b90:     number;
  over90:  number;
  total:   number;
}

function daysBetween(from: string, to: Date): number {
  const f = new Date(from + "T00:00:00Z");
  return Math.floor((to.getTime() - f.getTime()) / (24 * 60 * 60 * 1000));
}

function useAging() {
  return useQuery({
    queryKey: ["accounting", "aging"],
    queryFn: async (): Promise<{ rows: CustomerAgingRow[]; totals: AgingTotals }> => {
      const supabase = createClient();

      // Unpaid / partially-paid invoices = the outstanding pool.
      // We use `net_payable` when present (= amount − adjusted advances)
      // otherwise fall back to `amount`. Invoices already 'paid' or 'void'
      // are excluded.
      const { data: invoices, error: invErr } = await supabase
        .from("invoices")
        .select("id, customer_id, customer_name, amount, net_payable, status, invoice_date, due_date")
        .in("status", ["pending", "overdue"]);
      if (invErr) throw invErr;

      // Pull customer contact info so the row can offer WhatsApp / email.
      const customerIds = Array.from(
        new Set((invoices ?? []).map((i) => i.customer_id).filter((x): x is string => !!x)),
      );
      const contactsByCustomerId = new Map<string, { email: string | null; phone: string | null }>();
      if (customerIds.length > 0) {
        const { data: customers } = await supabase
          .from("customers")
          .select("id, contact_email, contact_phone")
          .in("id", customerIds);
        for (const c of customers ?? []) {
          contactsByCustomerId.set(c.id, {
            email: c.contact_email ?? null,
            phone: c.contact_phone ?? null,
          });
        }
      }

      const today = new Date();
      const grouped = new Map<string, CustomerAgingRow>();

      for (const inv of invoices ?? []) {
        const owed = inv.net_payable ?? inv.amount ?? 0;
        if (owed <= 0) continue;

        const days     = daysBetween(inv.invoice_date, today);
        const key      = inv.customer_id ?? inv.customer_name ?? "unknown";
        const contact  = inv.customer_id ? contactsByCustomerId.get(inv.customer_id) : null;

        let row = grouped.get(key);
        if (!row) {
          row = {
            customerId:      inv.customer_id ?? null,
            customerName:    inv.customer_name ?? "—",
            contactEmail:    contact?.email ?? null,
            contactPhone:    contact?.phone ?? null,
            buckets:         { current: 0, b30: 0, b60: 0, b90: 0, over90: 0 },
            total:           0,
            oldestDays:      0,
            oldestInvoiceId: null,
          };
          grouped.set(key, row);
        }

        // Bucket assignment by days since invoice date
        if      (days <=  30) row.buckets.current += owed;
        else if (days <=  60) row.buckets.b30     += owed;
        else if (days <=  90) row.buckets.b60     += owed;
        else                  row.buckets.over90  += owed;

        row.total += owed;
        if (days > row.oldestDays) {
          row.oldestDays      = days;
          row.oldestInvoiceId = inv.id;
        }
      }

      const rows = Array.from(grouped.values()).sort((a, b) => b.total - a.total);

      const totals: AgingTotals = {
        current: 0, b30: 0, b60: 0, b90: 0, over90: 0, total: 0,
      };
      for (const r of rows) {
        totals.current += r.buckets.current;
        totals.b30     += r.buckets.b30;
        totals.b60     += r.buckets.b60;
        totals.b90     += r.buckets.b90;
        totals.over90  += r.buckets.over90;
        totals.total   += r.total;
      }

      return { rows, totals };
    },
  });
}

// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────

function whatsappLink(phone: string, message: string): string {
  // Strip +, spaces, dashes
  const clean = phone.replace(/[^0-9]/g, "");
  return `https://wa.me/${clean}?text=${encodeURIComponent(message)}`;
}

export default function AgingPage() {
  const { data, isLoading } = useAging();
  const { data: me } = useCurrentUser();
  // Reminder messages are sent FROM this reseller — use their own business name,
  // never a hardcoded one (this is multi-tenant; another reseller must not send
  // messages branded with someone else's company).
  const bizName = me?.tenantName ?? "us";
  const rows   = data?.rows   ?? [];
  const totals = data?.totals ?? { current: 0, b30: 0, b60: 0, b90: 0, over90: 0, total: 0 };

  const overdueRupees = totals.b30 + totals.b60 + totals.b90 + totals.over90;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Customer Aging</h1>
          <p className="text-sm text-ink-3 mt-1">
            Who owes you money, and for how long. Sorted by largest exposure.
          </p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4 mb-6">
        <KPI label="Total outstanding" value={rupee(totals.total)} tone={totals.total > 0 ? "rose" : undefined} big />
        <KPI label="Current (0–30 days)" value={rupee(totals.current)} />
        <KPI label="31–60 days"          value={rupee(totals.b30)}     tone={totals.b30 > 0 ? "amber" : undefined} />
        <KPI label="61–90 days"          value={rupee(totals.b60)}     tone={totals.b60 > 0 ? "amber" : undefined} />
        <KPI label="90+ days"            value={rupee(totals.over90)}  tone={totals.over90 > 0 ? "rose" : undefined} />
      </div>

      {totals.total > 0 && overdueRupees > 0 && (
        <Card className="p-4 mb-6 border-rose/40 bg-rose-soft/30">
          <div className="text-sm text-ink-2 leading-relaxed">
            <Icon name="alert" size={16} className="text-rose inline mr-1.5 align-text-bottom" />
            <b>{rupee(overdueRupees)}</b> is overdue (31+ days). Healthy SME accounts
            receivable should be {totals.total > 0 ? Math.round((totals.current / totals.total) * 100) : 0}%+ in
            the &quot;Current&quot; bucket — chase the 31+ day rows below.
          </div>
        </Card>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="check_circle"
            title="No outstanding receivables"
            body="Every invoice is either paid in full or hasn't been issued. Nice."
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-3">Customer</th>
                  <th className="text-right px-4 py-3">Current</th>
                  <th className="text-right px-4 py-3">31–60</th>
                  <th className="text-right px-4 py-3">61–90</th>
                  <th className="text-right px-4 py-3">90+</th>
                  <th className="text-right px-4 py-3">Total</th>
                  <th className="text-left  px-4 py-3">Oldest</th>
                  <th className="text-right px-4 py-3">Follow up</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((r) => (
                  <tr key={r.customerId ?? r.customerName} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{r.customerName}</div>
                      {(r.contactEmail || r.contactPhone) && (
                        <div className="text-2xs text-ink-3 mt-0.5">
                          {r.contactEmail ?? r.contactPhone}
                        </div>
                      )}
                    </td>
                    <Cell value={r.buckets.current} />
                    <Cell value={r.buckets.b30}     tone={r.buckets.b30    > 0 ? "amber" : undefined} />
                    <Cell value={r.buckets.b60}     tone={r.buckets.b60    > 0 ? "amber" : undefined} />
                    <Cell value={r.buckets.over90}  tone={r.buckets.over90 > 0 ? "rose"  : undefined} />
                    <td className="px-4 py-3 text-right">
                      <div className="font-semibold text-ink font-mono">{rupee(r.total)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge kind={r.oldestDays > 90 ? "danger" : r.oldestDays > 30 ? "warning" : "muted"}>
                        {r.oldestDays} days
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {r.contactPhone && (
                        <a
                          href={whatsappLink(r.contactPhone,
                            `Hi from ${bizName} — just a reminder that ${rupee(r.total)} is pending on your account. Could you let me know when payment will reach us?`)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-emerald hover:underline mr-2"
                        >
                          <Icon name="whatsapp" size={12} /> WA
                        </a>
                      )}
                      {r.contactEmail && (
                        <a
                          href={`mailto:${r.contactEmail}?subject=${encodeURIComponent(`Payment reminder — ${rupee(r.total)} outstanding`)}`}
                          className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"
                        >
                          <Icon name="mail" size={12} /> Email
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-paper-2/30 border-t-2 border-ink">
                <tr>
                  <td className="px-4 py-3 text-2xs uppercase tracking-wider text-ink-3 font-semibold">Total</td>
                  <td className="px-4 py-3 text-right font-mono text-ink">{rupee(totals.current)}</td>
                  <td className="px-4 py-3 text-right font-mono text-amber-ink">{rupee(totals.b30)}</td>
                  <td className="px-4 py-3 text-right font-mono text-amber-ink">{rupee(totals.b60)}</td>
                  <td className="px-4 py-3 text-right font-mono text-rose">{rupee(totals.over90)}</td>
                  <td className="px-4 py-3 text-right font-serif text-lg text-ink">{rupee(totals.total)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </Card>

          {/* Mobile card list */}
          <ul className="md:hidden space-y-2.5">
            {rows.map((r) => (
              <li key={r.customerId ?? r.customerName}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="font-medium text-ink leading-tight">{r.customerName}</div>
                    <div className="font-serif text-xl text-ink leading-none">{rupee(r.total)}</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 text-2xs mb-3">
                    <Mini label="Current" value={r.buckets.current} />
                    <Mini label="31–60"   value={r.buckets.b30}    tone={r.buckets.b30   > 0 ? "amber" : undefined} />
                    <Mini label="61–90"   value={r.buckets.b60}    tone={r.buckets.b60   > 0 ? "amber" : undefined} />
                    <Mini label="90+"     value={r.buckets.over90} tone={r.buckets.over90 > 0 ? "rose" : undefined} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Badge kind={r.oldestDays > 90 ? "danger" : r.oldestDays > 30 ? "warning" : "muted"}>
                      {r.oldestDays} days old
                    </Badge>
                    <div className="flex gap-2">
                      {r.contactPhone && (
                        <a
                          href={whatsappLink(r.contactPhone,
                            `Hi from ${bizName} — ${rupee(r.total)} is pending on your account. When can we expect the payment?`)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs text-paper"
                          style={{ background: "#25D366" }}
                        >
                          <Icon name="whatsapp" size={12} /> WhatsApp
                        </a>
                      )}
                      {r.contactEmail && (
                        <a
                          href={`mailto:${r.contactEmail}?subject=${encodeURIComponent(`Payment reminder — ${rupee(r.total)} outstanding`)}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border border-hairline text-ink-2"
                        >
                          <Icon name="mail" size={12} /> Email
                        </a>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Cell + Mini primitives
// ────────────────────────────────────────────────────────────────

function Cell({ value, tone }: { value: number; tone?: "amber" | "rose" }) {
  const colorClass = tone === "rose" ? "text-rose"
                   : tone === "amber" ? "text-amber-ink"
                   : "text-ink-2";
  return (
    <td className={`px-4 py-3 text-right font-mono ${colorClass}`}>
      {value > 0 ? rupee(value) : "—"}
    </td>
  );
}

function Mini({ label, value, tone }: { label: string; value: number; tone?: "amber" | "rose" }) {
  const colorClass = tone === "rose" ? "text-rose"
                   : tone === "amber" ? "text-amber-ink"
                   : "text-ink-3";
  return (
    <div className="rounded-md border border-hairline p-1.5 text-center bg-paper">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold leading-none mb-0.5">{label}</div>
      <div className={`font-mono leading-none ${colorClass}`}>{value > 0 ? rupee(value) : "—"}</div>
    </div>
  );
}

function KPI({
  label, value, tone, big,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "rose" | "amber";
  big?: boolean;
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : tone === "amber"   ? "text-amber-ink"
                   : "text-ink";
  return (
    <Card className="p-3 md:p-4">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif ${big ? "text-2xl md:text-3xl" : "text-xl md:text-2xl"} ${colorClass} leading-tight`}>
        {value}
      </div>
    </Card>
  );
}
