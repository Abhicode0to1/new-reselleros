/**
 * The two charts on the SaaS-metrics page: where MRR has been, and how fast cohorts decay.
 *
 * Recharts, because it is already a dependency and already the idiom on /reports and in
 * pnl-charts.tsx. Tremor was asked for and deliberately not used: it is not installed, it
 * would be a SECOND charting library in one codebase, and CLAUDE.md §2 refuses a new
 * dependency without strong justification. The argument is not new here — pnl-charts.tsx
 * makes it in its own header.
 *
 * Neither component computes anything. `mrrTrend`, `retentionCurve` and `retentionVelocity`
 * are pure functions with tests, for the reason that file states: a chart built on a wrong
 * number renders perfectly and nobody can see it.
 *
 * ─── THESE CHARTS ARE BUILT TO SAY "NOT YET" ────────────────────────────────
 * Measured on production, 25 Aug 2026: all seven subscriptions started in the SAME month and
 * all are still active. A retention chart drawn from that renders a flat line at 100%, which
 * an owner reads as "retention is perfect" when the truth is "there is one month of data".
 *
 * So the velocity card refuses to print a number until there are two cohorts of different
 * ages, and says why in a sentence instead. That refusal is the feature, not a placeholder:
 * a young book is exactly when a flattering chart does the most damage, because there is
 * nothing yet to contradict it.
 */
"use client";

import * as React from "react";
import {
  ResponsiveContainer,
  AreaChart, Area,
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import type { MrrPoint, RetentionPoint, RetentionVelocity } from "@/lib/accounting/saas-charts";

/** Brand amber (§5). Recharts fills need a colour string — an SVG cannot read a CSS variable. */
const AMBER = "#C2410C";
const TEAL = "#0F766E";
const AXIS = "#6B7280";

/** Caveats, rendered as the page's existing note style rather than a new one. */
function Notes({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1.5">
      {items.map((n, i) => (
        <li key={i} className="flex gap-2 text-2xs leading-relaxed text-ink-3">
          <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * MRR by month.
 *
 * An area chart rather than bars: the question is "is the book growing", which is a shape,
 * and bars invite month-to-month comparison of numbers this series cannot support (see the
 * caveats — past months carry today's rate).
 */
export function MrrTrendChart({
  points,
  caveats,
}: {
  points: readonly MrrPoint[];
  caveats: readonly string[];
}) {
  const hasAny = points.some((p) => p.mrr > 0);
  /* How many months actually contain something. One is not a trend, and the badge says so
     rather than letting a single filled month read as a rising line. */
  const monthsWithData = points.filter((p) => p.active > 0).length;

  return (
    <Card className="print-keep p-5 md:p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
            MRR by month
          </div>
          <div className="mt-0.5 text-xs text-ink-3">
            Reconstructed from the subscriptions on the book
          </div>
        </div>
        <Badge kind={monthsWithData >= 3 ? "success" : "warning"}>
          {monthsWithData === 0
            ? "No data"
            : monthsWithData === 1
              ? "1 month — not a trend"
              : `${monthsWithData} months`}
        </Badge>
      </div>

      <div style={{ height: 220 }}>
        {hasAny ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points as MrrPoint[]} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
              <defs>
                <linearGradient id="mrrFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={AMBER} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={AMBER} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
              <YAxis
                tick={{ fontSize: 11, fill: AXIS }}
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={(v: number) => rupee(v, { compact: true })}
              />
              <Tooltip
                formatter={(v: number, _n, item) => [
                  `${rupee(v)} · ${(item?.payload as MrrPoint | undefined)?.active ?? 0} subscriptions`,
                  "MRR",
                ]}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Area
                type="monotone"
                dataKey="mrr"
                stroke={AMBER}
                strokeWidth={2}
                fill="url(#mrrFill)"
                /* Dots shown when the series is short. With two points a line without dots
                   is indistinguishable from an axis. */
                dot={monthsWithData <= 3 ? { r: 3, fill: AMBER } : false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-ink-3">
            No subscriptions on the book yet
          </div>
        )}
      </div>

      <Notes items={caveats} />
    </Card>
  );
}

/**
 * Retention by cohort age.
 *
 * The x-axis is AGE, not calendar month, because "cohorts still hold 90% after three months"
 * is a sentence about the business while "May was 90%" is a sentence about May.
 */
export function RetentionVelocityChart({
  curve,
  velocity,
}: {
  curve: readonly RetentionPoint[];
  velocity: RetentionVelocity;
}) {
  const measurable = velocity.pointsPerMonth !== null;

  /* Recharts plots left-to-right in array order, and the curve arrives oldest-first. Age
     descending would draw the passage of time backwards. */
  const data = [...curve].sort((a, b) => a.ageMonths - b.ageMonths);

  return (
    <Card className="print-keep p-5 md:p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
            Retention velocity
          </div>
          {/* The definition, on the card. An invented metric with no definition beside it is
              worse than no metric — two readers will assume two different things. */}
          <div className="mt-0.5 text-xs text-ink-3">
            How much retention each monthly cohort has lost, by how old it is
          </div>
        </div>
        {/* `muted`, not a colour, when there is nothing to measure — a grey chip cannot be
            misread as a verdict, and green here would say "retention is fine". */}
        <Badge kind={measurable ? (velocity.pointsPerMonth! < 0 ? "warning" : "success") : "muted"}>
          {measurable
            ? `${velocity.pointsPerMonth! > 0 ? "+" : ""}${velocity.pointsPerMonth} pts / month`
            : "Not measurable yet"}
        </Badge>
      </div>

      <div style={{ height: 220 }}>
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
              <XAxis
                dataKey="ageMonths"
                type="number"
                domain={[0, "dataMax"]}
                allowDecimals={false}
                tick={{ fontSize: 11, fill: AXIS }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => (v === 0 ? "new" : `${v}m`)}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: AXIS }}
                tickLine={false}
                axisLine={false}
                /* 48, not 40. At 40 the top tick renders as "00%" — Recharts clips rather
                   than widening, so the one label that anchors the whole scale is the one
                   that gets cut. Caught in the browser; no test would have seen it. */
                width={48}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip
                formatter={(v: number, _n, item) => {
                  const p = item?.payload as RetentionPoint | undefined;
                  return [`${Math.round(v)}% retained · ${p?.startedCount ?? 0} started`, p?.label ?? ""];
                }}
                labelFormatter={(v: number) => (v === 0 ? "This month's cohort" : `${v} month${v === 1 ? "" : "s"} old`)}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <ReferenceLine y={100} stroke="#E5E7EB" />
              <Line
                type="monotone"
                dataKey="retentionPct"
                stroke={measurable ? TEAL : AXIS}
                strokeWidth={2}
                /* Dashed when there is nothing to measure, so the line cannot be mistaken for
                   a measured trend at a glance. */
                strokeDasharray={measurable ? undefined : "4 4"}
                dot={{ r: 3, fill: measurable ? TEAL : AXIS }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-ink-3">
            No cohorts yet
          </div>
        )}
      </div>

      {/* The sentence, always — including when there IS a number, because "−4 pts/month"
          alone does not tell the reader how many cohorts it was fitted to. */}
      <Notes items={[velocity.explanation]} />
    </Card>
  );
}
