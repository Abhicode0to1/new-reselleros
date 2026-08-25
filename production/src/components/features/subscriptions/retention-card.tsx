"use client";

/**
 * Net Revenue Retention.
 *
 * ─── WITH ONE SNAPSHOT IT SAYS SO, RATHER THAN SHOWING 100% ─────────────────
 * Retention is a comparison. Nothing recorded historic MRR before
 * migration 20260816160000, so until the monthly job has run twice there is nothing
 * to compare — and an empty comparison arithmetically produces 100%, which on a
 * dashboard reads as perfect retention. This renders the wait instead, with when it
 * will resolve.
 *
 * ─── NEW MRR IS SHOWN BESIDE NRR, NEVER INSIDE IT ───────────────────────────
 * A big new logo would push NRR over 500% while every existing customer shrank. The
 * two numbers are next to each other because both matter; they are separate because
 * mixing them makes the metric rise fastest when retention is worst.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { cn, rupee } from "@/lib/utils";
import type { MrrSnapshot } from "@/lib/supabase/database.types";
import { computeRetention, retentionVerdict, fmtBps } from "@/lib/analytics/retention";

const VERDICT_TONE = {
  excellent: "text-emerald",
  healthy:   "text-emerald",
  leaking:   "text-amber-ink",
  bleeding:  "text-rose",
  unknown:   "text-ink-3",
} as const;

export function RetentionCard({ snapshots }: { snapshots: MrrSnapshot[] }) {
  const periods = React.useMemo(
    () => [...new Set(snapshots.map((s) => s.period))].sort(),
    [snapshots],
  );

  if (periods.length < 2) {
    const next = nextFirstOfMonth();
    return (
      <Card title="Revenue retention" sub="How much of last period's revenue you still have">
        <p className="text-sm text-ink-2">
          {periods.length === 0
            ? "No monthly snapshots yet."
            : "Only one month recorded so far."}
        </p>
        <p className="mt-1.5 text-[12px] leading-snug text-ink-3">
          Retention is a comparison between two months, and nothing recorded historic MRR
          until now. The first real figure appears after the snapshot on{" "}
          <b className="text-ink-2">{next}</b>
          {periods.length === 1 ? "." : ", and the one after that."} Showing a number before
          then would mean inventing one.
        </p>
      </Card>
    );
  }

  const latest = periods[periods.length - 1];
  const previous = periods[periods.length - 2];
  const start = snapshots.filter((s) => s.period === previous).map((s) => ({ customerId: s.customer_id, mrr: s.mrr }));
  const end   = snapshots.filter((s) => s.period === latest).map((s) => ({ customerId: s.customer_id, mrr: s.mrr }));

  const r = computeRetention(start, end);
  const v = retentionVerdict(r);

  return (
    <Card
      title="Revenue retention"
      sub={`${fmtMonth(previous)} → ${fmtMonth(latest)}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <p className="text-3xs uppercase tracking-wider font-semibold text-ink-3">Net revenue retention</p>
          <p className={cn("font-serif text-3xl font-bold tabular-nums", VERDICT_TONE[v.verdict])}>
            {fmtBps(r.nrrBps)}
          </p>
        </div>
        <div>
          <p className="text-3xs uppercase tracking-wider font-semibold text-ink-3">Gross (no expansion)</p>
          <p className="font-serif text-xl font-semibold tabular-nums text-ink-2">{fmtBps(r.grrBps)}</p>
        </div>
        <div>
          <p className="text-3xs uppercase tracking-wider font-semibold text-ink-3">New customers</p>
          <p className="font-serif text-xl font-semibold tabular-nums text-ink-2">{rupee(r.newMrr)}<span className="text-3xs font-normal text-ink-3">/mo</span></p>
          {/* Stated on the card, not just in a comment — this is the number people
              expect to see folded in. */}
          <p className="text-3xs text-ink-3">not counted in NRR</p>
        </div>
      </div>

      <p className="mt-2 text-[12px] leading-snug text-ink-2">{v.message}</p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Movement label="Started with" value={rupee(r.startingMrr)} />
        <Movement label="Expansion" value={`+${rupee(r.expansion)}`} tone="good" count={r.counts.expanded} />
        <Movement label="Contraction" value={`−${rupee(r.contraction)}`} tone="warn" count={r.counts.contracted} />
        <Movement label="Churned" value={`−${rupee(r.churned)}`} tone="bad" count={r.counts.churned} />
      </div>

      <p className="mt-2 text-2xs text-ink-3">
        Ends at {rupee(r.endingCohortMrr)} from the same {r.counts.retained + r.counts.churned} customers.
      </p>
    </Card>
  );
}

function Movement({ label, value, tone, count }: {
  label: string; value: string; tone?: "good" | "warn" | "bad"; count?: number;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-paper-2/40 p-2.5">
      <p className="text-3xs uppercase tracking-wider font-semibold text-ink-3">{label}</p>
      <p className={cn(
        "mt-0.5 text-sm font-semibold tabular-nums",
        tone === "good" ? "text-emerald" : tone === "warn" ? "text-amber-ink" : tone === "bad" ? "text-rose" : "text-ink",
      )}>
        {value}
      </p>
      {count != null && count > 0 && (
        <p className="text-3xs text-ink-3">{count} {count === 1 ? "customer" : "customers"}</p>
      )}
    </div>
  );
}

function fmtMonth(period: string): string {
  const d = new Date(`${period}T00:00:00Z`);
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function nextFirstOfMonth(): string {
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return `1 ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][next.getUTCMonth()]} ${next.getUTCFullYear()}`;
}

export type { MrrSnapshot };
