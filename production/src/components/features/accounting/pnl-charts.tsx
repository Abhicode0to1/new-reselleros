/**
 * The two charts that answer questions the waterfall cannot.
 *
 * Recharts, because it is already a dependency and already the idiom on /reports. The
 * waterfall is hand-rolled SVG only because Recharts has no waterfall; a donut and a
 * bar+line are exactly what it is for, and hand-rolling those would be inventing a second
 * charting style in one codebase.
 *
 * Neither component computes anything. `profitContribution` and `monthlySeries` are pure
 * functions with tests, for the reason the waterfall's geometry is: a chart built on a
 * wrong number renders perfectly and nobody can see it.
 */
"use client";

import * as React from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell,
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { cn, rupee } from "@/lib/utils";
import type { ProfitSlice, MonthPoint } from "@/lib/accounting/pnl-charts";

/**
 * Palette. Amber is the brand accent (§5) and leads; the rest are the existing semantic
 * tokens' hex values, because Recharts fills need a colour string and cannot read a CSS
 * variable through the SVG it generates.
 */
const SLICE_COLORS = ["#C2410C", "#0F766E", "#7C3AED", "#B45309", "#0369A1", "#4D7C0F"];

/**
 * Profit contribution by vendor.
 *
 * ─── PROFIT, NOT REVENUE, AND THE LEGEND SAYS BOTH ──────────────────────────
 * A revenue donut for this reseller is one colour — Google is 98% of the book. The
 * interesting fact is that support is 2% of the SALES and 6% of the PROFIT, so the legend
 * carries both numbers and marks the vendor punching above its weight. A chart that only
 * showed the profit share would be prettier and would hide the comparison that makes it
 * worth looking at.
 */
export function ProfitDonut({
  slices, losing, totalGross, selected, onSelect,
}: {
  slices: readonly ProfitSlice[];
  losing: readonly { vendor: string; label: string; gross: number }[];
  totalGross: number;
  selected: string | "all";
  onSelect: (vendor: string | "all") => void;
}) {
  const data = slices.map((s) => ({ name: s.label, value: s.gross, vendor: s.vendor }));

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr] sm:items-center">
      <div className="relative" style={{ height: 180 }}>
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius={52}
                outerRadius={78}
                paddingAngle={2}
                stroke="none"
                onClick={(d: { vendor?: string }) => d.vendor && onSelect(d.vendor)}
              >
                {data.map((d, i) => (
                  <Cell
                    key={d.vendor}
                    fill={SLICE_COLORS[i % SLICE_COLORS.length]}
                    opacity={selected === "all" || selected === d.vendor ? 1 : 0.35}
                    cursor="pointer"
                  />
                ))}
              </Pie>
              <Tooltip
                formatter={(v: number, n: string) => [rupee(v), n]}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-ink-3">
            No profit to split yet
          </div>
        )}

        {/* The total, in the hole. A donut without its total makes the reader estimate
            from wedge sizes, which is the one thing people are bad at. */}
        {data.length > 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="text-center">
              <div className="font-serif text-lg leading-none text-ink tabular-nums">
                {rupee(totalGross, { compact: true })}
              </div>
              <div className="text-[10px] text-ink-3">gross profit</div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => onSelect("all")}
          className={cn(
            "w-full rounded-md px-2 py-1 text-left text-[12px] font-medium transition-colors",
            selected === "all" ? "bg-paper-2 text-ink" : "text-ink-2 hover:bg-paper-2/60",
          )}
        >
          All vendors
        </button>

        {slices.map((s, i) => (
          <button
            key={s.vendor}
            type="button"
            onClick={() => onSelect(s.vendor)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
              selected === s.vendor ? "bg-paper-2" : "hover:bg-paper-2/60",
            )}
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-ink">{s.label}</span>
              {/* Both shares, always. "6% of profit from 2% of sales" is the sentence. */}
              <span className="block text-[10px] text-ink-3 tabular-nums">
                {s.sharePct}% of profit · {s.revenueSharePct}% of sales
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-mono text-[12px] tabular-nums text-ink">
                {rupee(s.gross, { compact: true })}
              </span>
              {s.punchesAbove && <Badge kind="success" size="sm">earns more than it sells</Badge>}
            </span>
          </button>
        ))}

        {/* A loss can never be a wedge — there is no −15% of a circle. Said in words
            instead, which is the only honest rendering on a pie chart. */}
        {losing.map((l) => (
          <p key={l.vendor} className="px-2 text-[11px] leading-snug text-rose">
            {l.label} is <b>losing {rupee(Math.abs(l.gross))}</b> — it cannot be drawn as a slice,
            because a loss has no share of a profit.
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * Revenue bars with the net-margin line over them.
 *
 * ─── TWO AXES, AND THAT IS A REAL RISK ──────────────────────────────────────
 * Rupees and percent cannot share a scale, so the margin line has its own axis on the
 * right. Dual-axis charts are easy to misread — the crossing point of the two series
 * means nothing at all — so the axes are labelled and the line is thin and light against
 * solid bars, to read as an overlay rather than a second quantity.
 *
 * A month with no revenue plots a NULL margin, not a zero: Recharts joins the line across
 * it, which says "no sales, no margin to speak of" instead of drawing a cliff to −400%
 * that flattens every other month into a straight line.
 */
export function MonthlyTrend({ points }: { points: readonly MonthPoint[] }) {
  const data = points.map((p) => ({
    label: p.label,
    revenue: p.revenue,
    profit: p.netProfit,
    margin: p.marginPct,
    partial: p.partial,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ left: 0, right: 4, top: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-hairline" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis
          yAxisId="rupees"
          tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={44}
          tickFormatter={(v: number) => rupee(v, { compact: true })}
        />
        <YAxis
          yAxisId="pct" orientation="right"
          tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={34}
          tickFormatter={(v: number) => `${v}%`}
        />
        {/* Recharts types the formatter's value as its own `ValueType` (string | number |
            array), so the narrowing happens here rather than in the signature — the
            alternative is an `as` cast, which CLAUDE.md §17 rules out and which would
            silently mis-render the day a series changes shape. */}
        <Tooltip
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
          formatter={(value, name) => {
            const label = String(name);
            if (typeof value !== "number") return ["no sales", label];
            return label === "Net margin" ? [`${value}%`, label] : [rupee(value), label];
          }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar yAxisId="rupees" dataKey="revenue" name="Revenue" fill="#C2410C" opacity={0.75} radius={[3, 3, 0, 0]} />
        <Bar yAxisId="rupees" dataKey="profit"  name="Net profit" fill="#0F766E" opacity={0.75} radius={[3, 3, 0, 0]} />
        <Line
          yAxisId="pct" type="monotone" dataKey="margin" name="Net margin"
          stroke="#7C3AED" strokeWidth={1.75} dot={{ r: 2.5 }}
          /* connectNulls joins across a month with no revenue rather than breaking the
             line — a gap reads as missing data, and the data is not missing. */
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
