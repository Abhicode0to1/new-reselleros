/**
 * Dashboard "Deals" strip — four money tiles, each a link to /deals (30 Sep 2026).
 *
 * Numbers: lib/deals/pipeline-summary.ts (summarizeDealStrip), rows: lib/queries/deals.ts.
 * Renders nothing for a role that cannot open /deals (lib/deals/access.ts), and says so
 * when the read fails instead of showing ₹0 — a zero here would read as "no pipeline".
 */
"use client";

import Link from "next/link";
import type { Route } from "next";
import { KPI } from "@/components/shared/kpi";
import { useDealRows } from "@/lib/queries/deals";
import { summarizeDealStrip } from "@/lib/deals/pipeline-summary";
import { canSeeDeals } from "@/lib/deals/access";
import { rupee } from "@/lib/utils";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DealsStrip({ role }: { role: string | null | undefined }) {
  const allowed = canSeeDeals(role);
  const { data, isLoading, error } = useDealRows(allowed);
  if (!allowed) return null;

  const s = data ? summarizeDealStrip(data) : null;
  const loading = isLoading || !s;
  const tiles = s ? [
    { label: "Pipeline", value: rupee(s.pipeline.value, { compact: true }), icon: "target",
      trend: plural(s.pipeline.count, "open deal", "open deals") },
    { label: "Weighted", value: rupee(s.weighted, { compact: true }), icon: "trending_up",
      trend: "stage probability se" },
    { label: "Is mahine close hone wali", value: rupee(s.closingThisMonth.value, { compact: true }), icon: "calendar",
      trend: plural(s.closingThisMonth.count, "deal", "deals") },
    { label: "Is mahine Won", value: rupee(s.wonThisMonth.value, { compact: true }), icon: "check_circle",
      trend: plural(s.wonThisMonth.count, "deal", "deals"), accent: "emerald" as const },
  ] : [];

  return (
    <section aria-labelledby="dash-deals" className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <h2 id="dash-deals" className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Deals</h2>
        <Link href={"/deals" as Route} className="text-xs font-medium text-amber-ink hover:underline">
          Sab deals dekho →
        </Link>
      </div>
      {error ? (
        <p className="text-sm text-rose-ink rounded-lg border border-hairline bg-paper p-3">
          Deals load nahi hue — {(error as Error).message}. Ye ₹0 nahi hai; <Link href={"/deals" as Route} className="underline">/deals</Link> kholo.
        </p>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {loading
            ? ["Pipeline", "Weighted", "Is mahine close hone wali", "Is mahine Won"].map((l) => (
                <KPI key={l} label={l} value="" loading />
              ))
            : tiles.map((t) => (
                <Link
                  key={t.label}
                  href={"/deals" as Route}
                  className="block rounded-lg hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2"
                >
                  <KPI label={t.label} value={t.value} icon={t.icon} trend={t.trend} accent={t.accent ?? "ink"} />
                </Link>
              ))}
        </div>
      )}
    </section>
  );
}
