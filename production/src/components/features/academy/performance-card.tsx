"use client";

/**
 * Performance score card (R-150). The number comes from lib/academy/performance.ts —
 * computed from evaluations, marks and tasks, never stored. Shows how it was made, so a
 * mentor can see WHY someone is yellow, not just that they are.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import type { Performance } from "@/lib/academy/performance";

const BAND = {
  green: { label: "Excellent", dot: "bg-emerald", text: "text-emerald", ring: "border-emerald/40" },
  yellow: { label: "Needs attention", dot: "bg-amber", text: "text-amber-ink", ring: "border-amber/50" },
  red: { label: "At risk", dot: "bg-red-ink", text: "text-red-ink", ring: "border-red-ink/40" },
} as const;

export function ScoreChip({ perf }: { perf: Performance }) {
  if (perf.score == null || !perf.band) return <span className="text-xs text-ink-3">No score yet</span>;
  const b = BAND[perf.band];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${b.text}`} title={`Performance ${perf.score}/100 — ${b.label}`}>
      <span className={`w-2 h-2 rounded-full ${b.dot}`} aria-hidden />{perf.score}/100 · {b.label}
    </span>
  );
}

export function PerformanceCard({ perf, title = "Performance" }: { perf: Performance; title?: string }) {
  const b = perf.band ? BAND[perf.band] : null;
  return (
    <Card className={`p-5 space-y-4 border-2 ${b ? b.ring : "border-hairline"}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-serif text-xl">{title}</h2>
          <p className="text-xs text-ink-3">Evaluations 40 · marks 25 · tasks completed 20 · on time 15. Parts with no data yet are left out. Attendance joins in phase 4.</p>
        </div>
        <div className="text-right">
          <p className={`font-serif text-4xl tabular-nums ${b ? b.text : "text-ink-3"}`}>{perf.score ?? "—"}<span className="text-base text-ink-3">/100</span></p>
          <p className={`text-sm font-semibold ${b ? b.text : "text-ink-3"}`}>
            {b ? b.label : "No score yet"}
            {perf.trend === "up" && " · improving ↑"}{perf.trend === "down" && " · falling ↓"}
          </p>
        </div>
      </div>

      {perf.alerts.length > 0 && (
        <ul className="rounded-lg border border-red-ink/30 bg-red-ink/5 p-3 space-y-1 text-sm text-red-ink" role="alert">
          {perf.alerts.map((a) => <li key={a}>⚠ {a}</li>)}
        </ul>
      )}

      <ul className="grid gap-2 sm:grid-cols-2">
        {perf.parts.map((p) => (
          <li key={p.key} className="rounded-lg border border-hairline p-3">
            <div className="flex justify-between text-sm"><span className="font-semibold text-ink">{p.label}</span><span className="tabular-nums text-ink-2">{p.value == null ? "—" : `${Math.round(p.value)}%`}</span></div>
            <div className="h-1.5 rounded-full bg-paper-2 overflow-hidden mt-1.5"><div className="h-full bg-ink-2/70" style={{ width: `${p.value ?? 0}%` }} /></div>
            <p className="text-3xs text-ink-3 mt-1">{p.note} · weight {p.weight}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
