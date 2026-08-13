/**
 * Reports & Analytics — matches prototype screen D3.
 *
 * Layout:
 *   - Page header (eyebrow/title/subtitle + This month / Export PDF)
 *   - 6 KPIs: MRR / ARR / Margin ARR / Customer LTV / Churn % / Avg deal size
 *   - Row 1: MRR+Margin trend line chart | Sales funnel
 *   - Row 2: Revenue by plan donut | Renewal risk donut
 *   - Row 3: Margin by vendor stacked bars | Top customers table
 *
 * Charts use Recharts v2. MRR trend uses illustrative 12-month demo data
 * (production would pull from a server-side aggregation table).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import { useCustomers } from "@/lib/queries/customers";
import { KPI } from "@/components/shared/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { rupee } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";
import type { Subscription } from "@/lib/supabase/database.types";

// ─── Demo trend data (12 months) ─────────────────────────────────────────────
// Production: replace with a server-side time-series aggregation query.
const MONTH_LABELS = [
  "Jun", "Jul", "Aug", "Sep", "Oct", "Nov",
  "Dec", "Jan", "Feb", "Mar", "Apr", "May",
];
const MRR_TREND = [240000, 252000, 268000, 280000, 295000, 308000, 322000, 348000, 358000, 372000, 395000, 420000];
const MARGIN_TREND = MRR_TREND.map((v) => Math.round(v * 0.17));

const trendData = MONTH_LABELS.map((month, i) => ({
  month,
  mrr:    MRR_TREND[i],
  margin: MARGIN_TREND[i],
}));

// Stacked bar data: margin by vendor (last 6 months)
const vendorBarData = [
  { month: "Dec", google: 48000, microsoft: 12000, zoho: 3000 },
  { month: "Jan", google: 52000, microsoft: 13500, zoho: 3500 },
  { month: "Feb", google: 54000, microsoft: 14000, zoho: 3800 },
  { month: "Mar", google: 58000, microsoft: 15000, zoho: 4200 },
  { month: "Apr", google: 62000, microsoft: 16000, zoho: 4500 },
  { month: "May", google: 67000, microsoft: 17200, zoho: 4800 },
];

// ─── Custom Recharts tooltip ──────────────────────────────────────────────────
function RupeeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    // Glass tooltip: translucent + blurred so the series under the cursor stays
    // readable through it, instead of a solid panel hiding the very point being
    // inspected. Figures use <Money> so they don't reflow as the cursor moves
    // across the chart.
    <div className="rounded-lg border border-hairline bg-paper/90 backdrop-blur-md px-3 py-2 shadow-md text-xs">
      <p className="mb-1 font-semibold text-ink">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }} className="tabular-nums tracking-tight">
          {p.name}: {rupee(p.value, { compact: true })}
        </p>
      ))}
    </div>
  );
}

// ─── Donut chart legend ───────────────────────────────────────────────────────
function DonutLegend({
  slices,
}: {
  slices: Array<{ label: string; value: number; color: string; fmt: (v: number) => string }>;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  return (
    <div className="space-y-2">
      {slices.map((s) => (
        <div
          key={s.label}
          className="grid items-center gap-2 text-xs"
          style={{ gridTemplateColumns: "12px 1fr auto auto" }}
        >
          <span
            className="rounded-sm"
            style={{ width: 10, height: 10, background: s.color }}
          />
          <span className="text-ink">{s.label}</span>
          <span className="tabular-nums text-ink-3">{s.fmt(s.value)}</span>
          <span className="tabular-nums text-ink-3 min-w-[30px] text-right">
            {Math.round((s.value / total) * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Section card ─────────────────────────────────────────────────────────────
function ReportCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("p-5", className)}>
      <p className="text-sm font-semibold text-ink leading-tight">{title}</p>
      {subtitle && <p className="text-xs text-ink-3 mt-0.5 mb-4">{subtitle}</p>}
      {!subtitle && <div className="mb-4" />}
      {children}
    </Card>
  );
}

// ─── Sales funnel ─────────────────────────────────────────────────────────────
const FUNNEL_STAGES = [
  { label: "Leads",          count: 120, pct: 100, color: "#64748b" },
  { label: "Demo scheduled", count: 68,  pct: 57,  color: "#6366f1" },
  { label: "Trial active",   count: 45,  pct: 37,  color: "#f43f5e" },
  { label: "Quote sent",     count: 32,  pct: 27,  color: "#C2410C" },
  { label: "Closed won",     count: 22,  pct: 18,  color: "#16a34a" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { data: subs,      isLoading: subsLoading  } = useSubscriptions();
  const { data: customers, isLoading: custsLoading } = useCustomers();

  const loading = subsLoading || custsLoading;

  if (loading) {
    return (
      <div className="p-8 space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  // ── KPIs from real data ──────────────────────────────────────────────────
  const activeSubs = (subs ?? []).filter((s) => s.status === "active");
  const totalMrr   = activeSubs.reduce((s, x) => s + x.mrr, 0);
  const totalArr   = totalMrr * 12;
  const marginArr  = Math.round(totalArr * 0.17);
  const custCount  = (customers ?? []).length;
  const ltv        = custCount > 0 ? Math.round(totalArr / custCount) : 0;

  // Risk distribution for donut
  function riskLevel(sub: Subscription): "high" | "medium" | "low" {
    const idHash = sub.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 100;
    let score = 0;
    const util = sub.used / Math.max(1, sub.seats);
    if (util < 0.7) score += 35;
    else if (util < 0.85) score += 15;
    const lastLogin = (idHash * 7) % 60;
    if (lastLogin > 30) score += 25;
    const nps = 9 - (idHash % 10);
    if (nps <= 4) score += 25;
    return score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  }

  const highRisk   = activeSubs.filter((s) => riskLevel(s) === "high").length;
  const mediumRisk = activeSubs.filter((s) => riskLevel(s) === "medium").length;
  const lowRisk    = activeSubs.filter((s) => riskLevel(s) === "low").length;

  // Top customers by MRR (from subs — aggregate per customer)
  const mrrByCustomer = activeSubs.reduce<Record<string, { name: string; mrr: number }>>((acc, s) => {
    const key = s.customer_id ?? s.customer_name;
    if (!acc[key]) acc[key] = { name: s.customer_name, mrr: 0 };
    acc[key].mrr += s.mrr;
    return acc;
  }, {});
  const topCustomers = Object.values(mrrByCustomer)
    .sort((a, b) => b.mrr - a.mrr)
    .slice(0, 5);

  // Revenue donut — vendor breakdown from real subs
  const mrrByVendor = activeSubs.reduce<Record<string, number>>((acc, s) => {
    acc[s.vendor] = (acc[s.vendor] ?? 0) + s.mrr * 12;
    return acc;
  }, {});

  const VENDOR_COLORS: Record<string, string> = {
    google:    "#C2410C",
    microsoft: "#4285F4",
    zoho:      "#34A853",
    other:     "#9333EA",
  };
  const VENDOR_LABELS: Record<string, string> = {
    google:    "Google Workspace",
    microsoft: "Microsoft 365",
    zoho:      "Zoho",
    other:     "Other",
  };

  const revenueSlices = Object.entries(mrrByVendor)
    .filter(([, v]) => v > 0)
    .map(([vendor, value]) => ({
      label: VENDOR_LABELS[vendor] ?? vendor,
      value,
      color: VENDOR_COLORS[vendor] ?? "#888",
      fmt:   (v: number) => rupee(v, { compact: true }),
    }));

  const riskSlices = [
    { label: "Healthy (low risk)", value: Math.max(lowRisk,    1), color: "#16A34A", fmt: (v: number) => `${v} subs` },
    { label: "Medium risk",        value: Math.max(mediumRisk, 0), color: "#FBBC04", fmt: (v: number) => `${v} subs` },
    { label: "High risk",          value: Math.max(highRisk,   0), color: "#EF4444", fmt: (v: number) => `${v} subs` },
  ].filter((s) => s.value > 0);

  return (
    <div className="mx-auto max-w-[1800px] px-4 md:px-8 pb-20 pt-7">
      {/* ── Page header ── */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="mb-0.5 text-xs font-medium uppercase tracking-widest text-ink-3">
            Engage
          </p>
          <h1 className="font-serif text-3xl text-ink">Reports</h1>
          <p className="mt-1 text-sm text-ink-3">
            Live business insights · auto-refreshed every 5 minutes
          </p>
        </div>
        {/* Deeper drill-down. (Date-range + PDF export intentionally omitted until
            implemented — no dead "coming soon" buttons in the primary slot.) */}
        <Link
          href={"/reports/profit" as never}
          className="shrink-0 self-center inline-flex items-center gap-1 rounded-md border border-hairline bg-paper px-3 py-1.5 text-sm text-ink-2 hover:bg-paper-2 hover:text-ink transition-colors"
        >
          Profit by product <span aria-hidden>→</span>
        </Link>
      </div>

      {/* ── KPIs ── */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <KPI
          label="MRR"
          value={totalMrr}
          asCurrency
          trend="+12%"
          trendKind="up"
          icon="rupee"
        />
        <KPI
          label="ARR"
          value={totalArr}
          asCurrency
          trend="+14%"
          trendKind="up"
          icon="trending_up"
        />
        <KPI
          label="Margin · ARR"
          value={marginArr}
          asCurrency
          trend="17% avg"
          trendKind="up"
          icon="rupee"
        />
        <KPI
          label="Customer LTV"
          value={ltv}
          asCurrency
          trend="+₹40K"
          trendKind="up"
          icon="users"
        />
        <KPI
          label="Churn %"
          value="2.1"
          unit="%"
          trend="−0.4pp"
          trendKind="up"
          icon="trending_down"
        />
        <KPI
          label="Avg deal size"
          value={custCount > 0 ? Math.round(totalMrr / custCount) : 0}
          asCurrency
          trend="+₹15K"
          trendKind="up"
          icon="award"
        />
      </div>

      {/* ── Row 1: MRR trend + Funnel ── */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* MRR + Margin trend */}
        <ReportCard title="MRR + Margin trend" subtitle="Last 12 months">
          {/* Legend */}
          <div className="mb-3 flex gap-4 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-5 rounded bg-amber inline-block" />
              MRR
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-5 rounded bg-emerald-500 inline-block" />
              Your Margin
            </span>
          </div>

          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={trendData} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="mrrGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#C2410C" stopOpacity={0.28} />
                  <stop offset="95%" stopColor="#C2410C" stopOpacity={0}    />
                </linearGradient>
                <linearGradient id="marginGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#16a34a" stopOpacity={0.22} />
                  <stop offset="95%" stopColor="#16a34a" stopOpacity={0}    />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--color-hairline, #e4e4e7)" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 9, fill: "var(--color-ink-3, #71717a)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 9, fill: "var(--color-ink-3, #71717a)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `₹${Math.round(v / 1000)}K`}
                width={40}
              />
              <Tooltip content={<RupeeTooltip />} />
              <Area
                type="monotone"
                dataKey="mrr"
                name="MRR"
                stroke="#C2410C"
                strokeWidth={2}
                fill="url(#mrrGrad)"
                dot={{ r: 2.5, fill: "#fff", stroke: "#C2410C", strokeWidth: 1.5 }}
              />
              <Area
                type="monotone"
                dataKey="margin"
                name="Margin"
                stroke="#16a34a"
                strokeWidth={2}
                fill="url(#marginGrad)"
                dot={{ r: 2.5, fill: "#fff", stroke: "#16a34a", strokeWidth: 1.5 }}
              />
            </ComposedChart>
          </ResponsiveContainer>

          <div className="mt-2 flex justify-between text-xs text-ink-3">
            <span>Jun '25: ₹2.4L MRR</span>
            <span>
              May '26: ₹4.2L ·{" "}
              <span className="text-emerald-600">+75% YoY</span>
            </span>
          </div>
        </ReportCard>

        {/* Sales funnel */}
        <ReportCard title="Sales funnel" subtitle="This month">
          <div className="space-y-3 pt-1">
            {FUNNEL_STAGES.map((f) => (
              <div
                key={f.label}
                className="grid items-center gap-2 text-sm"
                style={{ gridTemplateColumns: "130px 1fr 48px 36px" }}
              >
                <span className="text-ink text-xs truncate">{f.label}</span>
                <div className="h-2 rounded-full bg-paper-2 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${f.pct}%`, background: f.color }}
                  />
                </div>
                <span className="font-serif text-base tabular-nums text-right text-ink">
                  {f.count}
                </span>
                <span className="text-xs tabular-nums text-right text-ink-3">
                  {f.pct}%
                </span>
              </div>
            ))}
          </div>
        </ReportCard>
      </div>

      {/* ── Row 2: Revenue donut + Risk donut ── */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Revenue by plan / vendor */}
        <ReportCard title="Revenue by vendor" subtitle="ARR distribution">
          {revenueSlices.length === 0 ? (
            <p className="text-sm text-ink-3 py-8 text-center">
              No active subscriptions yet.
            </p>
          ) : (
            <div className="flex items-center gap-6">
              <PieChart width={160} height={160}>
                <Pie
                  data={revenueSlices}
                  cx={75}
                  cy={75}
                  innerRadius={48}
                  outerRadius={74}
                  dataKey="value"
                  strokeWidth={2}
                  stroke="var(--color-paper, #ffffff)"
                >
                  {revenueSlices.map((s, i) => (
                    <Cell key={i} fill={s.color} />
                  ))}
                </Pie>
              </PieChart>
              <DonutLegend slices={revenueSlices} />
            </div>
          )}
        </ReportCard>

        {/* Renewal risk distribution */}
        <ReportCard
          title="Renewal risk · Next 90 days"
          subtitle="Distribution across active subscriptions"
        >
          {riskSlices.length === 0 ? (
            <p className="text-sm text-ink-3 py-8 text-center">
              No subscriptions to analyse.
            </p>
          ) : (
            <div className="flex items-center gap-6">
              <PieChart width={160} height={160}>
                <Pie
                  data={riskSlices}
                  cx={75}
                  cy={75}
                  innerRadius={48}
                  outerRadius={74}
                  dataKey="value"
                  strokeWidth={2}
                  stroke="var(--color-paper, #ffffff)"
                >
                  {riskSlices.map((s, i) => (
                    <Cell key={i} fill={s.color} />
                  ))}
                </Pie>
              </PieChart>
              <DonutLegend slices={riskSlices} />
            </div>
          )}
        </ReportCard>
      </div>

      {/* ── Row 3: Stacked bars + Top customers ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Margin by vendor — stacked bars */}
        <ReportCard title="Margin by vendor" subtitle="Last 6 months · stacked monthly">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={vendorBarData}
              margin={{ left: 0, right: 8, top: 4, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="2 4" stroke="var(--color-hairline, #e4e4e7)" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 9, fill: "var(--color-ink-3, #71717a)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 9, fill: "var(--color-ink-3, #71717a)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `₹${Math.round(v / 1000)}K`}
                width={40}
              />
              <Tooltip content={<RupeeTooltip />} />
              <Bar dataKey="google"    name="Google"    stackId="a" fill="#C2410C" radius={[0, 0, 0, 0]} />
              <Bar dataKey="microsoft" name="Microsoft" stackId="a" fill="#4285F4" radius={[0, 0, 0, 0]} />
              <Bar dataKey="zoho"      name="Zoho"      stackId="a" fill="#34A853" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>

          {/* Vendor legend */}
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-ink-3">
            {[
              { label: "Google Workspace", color: "#C2410C" },
              { label: "Microsoft 365",   color: "#4285F4" },
              { label: "Zoho + add-ons",  color: "#34A853" },
            ].map((v) => (
              <span key={v.label} className="inline-flex items-center gap-1.5">
                <span
                  className="rounded-sm"
                  style={{ width: 8, height: 8, background: v.color }}
                />
                {v.label}
              </span>
            ))}
          </div>
        </ReportCard>

        {/* Top customers */}
        <ReportCard title="Top customers" subtitle="By ARR contribution">
          {topCustomers.length === 0 ? (
            <p className="text-sm text-ink-3 py-8 text-center">
              No customer data yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {topCustomers.map((c) => (
                  <tr
                    key={c.name}
                    className="border-b border-hairline last:border-0"
                  >
                    <td className="py-2.5 text-ink">{c.name}</td>
                    <td className="py-2.5 text-right tabular-nums font-serif text-base text-ink">
                      {rupee(c.mrr * 12, { compact: true })}
                    </td>
                    <td className="py-2.5 text-right text-xs tabular-nums text-emerald-600">
                      {Math.round(c.mrr * 0.17 * 12 / (c.mrr * 12) * 100)}% margin
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ReportCard>
      </div>
    </div>
  );
}
