"use client";

/**
 * StatStrip — a compact, single-row replacement for big KPI-card grids.
 *
 * The large KPI cards (≈120px tall) ate vertical space and pushed the actual
 * list far down the page. This renders the same metrics as a thin inline strip
 * (≈32px), wrapping gracefully on narrow screens. Used by list pages that
 * already have a tab/views filter (Quotes, Invoices) so the header stays tight.
 *
 * A stat may be made actionable by passing `onClick` — it then renders as a
 * button (e.g. "Receivables due" → filter to who owes). Backwards compatible:
 * stats without `onClick` render exactly as before.
 */
import { cn } from "@/lib/utils";

export type Stat = {
  label: string;
  value: string | number;
  tone?: "default" | "rose" | "emerald" | "amber";
  /** When set, the stat becomes a button (e.g. jump to a filtered view). */
  onClick?: () => void;
  /** Marks a clickable stat as the currently-active filter. */
  active?: boolean;
};

function toneClass(tone: Stat["tone"]) {
  return tone === "rose" ? "text-rose"
    : tone === "emerald" ? "text-emerald"
    : tone === "amber" ? "text-amber-ink"
    : "text-ink";
}

export function StatStrip({ items, className }: { items: Stat[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-6 gap-y-2", className)}>
      {items.map((it, i) => {
        const label = <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{it.label}</span>;
        const value = <span className={cn("text-base font-semibold tabular-nums", toneClass(it.tone))}>{it.value}</span>;
        if (it.onClick) {
          return (
            <button
              key={i}
              type="button"
              onClick={it.onClick}
              aria-pressed={it.active ?? undefined}
              className={cn(
                "flex items-baseline gap-1.5 rounded px-1 -mx-1 transition-colors",
                "hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                it.active && "bg-amber-soft/50",
              )}
              title={`Filter to ${it.label}`}
            >
              {label}
              {value}
            </button>
          );
        }
        return (
          <div key={i} className="flex items-baseline gap-1.5">
            {label}
            {value}
          </div>
        );
      })}
    </div>
  );
}
