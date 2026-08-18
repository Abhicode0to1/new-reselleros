/**
 * The money-flow waterfall.
 *
 * Draws what `layoutWaterfall` computed and decides nothing itself — the running totals
 * are arithmetic with tests, and a chart that quietly re-derives them is a chart that can
 * disagree with the table beside it.
 *
 * ─── EVERY BAR IS A BUTTON ──────────────────────────────────────────────────
 * Clicking Revenue, Licence cost or Running costs opens the same drill-down dialog the
 * table rows use, so the chart is a way IN rather than a picture to look at. The two
 * subtotals are not clickable: there is no such thing as "the invoices behind gross
 * margin", and a button that opens an empty drawer teaches people to stop pressing
 * buttons.
 *
 * ─── AN ESTIMATE IS DRAWN DIFFERENTLY ───────────────────────────────────────
 * With no vendor bills recorded, the licence cost comes from the wholesale rate card. It
 * renders hatched. A solid bar is a claim about money that changed hands, and this one
 * has not — the reseller's own rate card says it should have.
 */
"use client";

import * as React from "react";
import { cn, rupee } from "@/lib/utils";
import { layoutWaterfall, type WaterfallInput } from "@/lib/accounting/waterfall";

/** Plot height in px. Labels live outside it, so this is the bars' own space. */
const PLOT_H = 176;

export function PnlWaterfall({
  steps, onSelect, className,
}: {
  steps: readonly WaterfallInput[];
  /** Called with the step key for the three clickable bars. */
  onSelect?: (key: string) => void;
  className?: string;
}) {
  const { bars, zeroFrac } = React.useMemo(() => layoutWaterfall(steps), [steps]);

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-end gap-2 sm:gap-3" style={{ height: PLOT_H }}>
        {bars.map((b) => {
          const clickable = !b.isTotal && !!onSelect;
          const h = Math.max(2, b.heightFrac * PLOT_H);   // 2px floor: a ₹0 bar still shows a tick
          const base = b.baseFrac * PLOT_H;

          const fill =
            b.direction === "total"
              ? (b.end >= 0 ? "bg-emerald/70" : "bg-rose/70")
              : b.direction === "up" ? "bg-amber/70" : "bg-rose/60";

          const Bar = (
            <span
              className={cn(
                "block w-full rounded-sm transition-opacity",
                fill,
                clickable && "group-hover:opacity-80",
              )}
              style={{
                height: h,
                marginBottom: base,
                /* The hatch. Inline because it is a generated pattern, not a token —
                   globals.css has no repeating-linear-gradient utility and inventing one
                   for a single chart would be a token nobody else uses (§5). */
                ...(b.estimated
                  ? {
                      backgroundImage:
                        "repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 4px, transparent 4px 8px)",
                    }
                  : {}),
              }}
            />
          );

          return (
            <div key={b.key} className="flex min-w-0 flex-1 flex-col justify-end" style={{ height: PLOT_H }}>
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onSelect?.(b.key)}
                  title={`${b.label} · ${rupee(b.magnitude)} — see the entries`}
                  className="group flex h-full w-full cursor-pointer flex-col justify-end rounded-sm focus:outline-none focus:ring-1 focus:ring-amber"
                >
                  {Bar}
                </button>
              ) : (
                <span title={`${b.label} · ${rupee(b.magnitude)}`} className="flex h-full flex-col justify-end">
                  {Bar}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* The zero line, drawn only when something went below it — otherwise it is just
          the bottom of the chart and a second rule there is noise. */}
      {zeroFrac > 0.001 && (
        <div
          aria-hidden
          className="relative"
          style={{ height: 0 }}
        >
          <div
            className="absolute left-0 right-0 border-t border-dashed border-ink-3/50"
            style={{ bottom: zeroFrac * PLOT_H }}
          />
        </div>
      )}

      {/* Labels under the bars. Amount first, because that is what the eye came for. */}
      <div className="mt-2 flex items-start gap-2 border-t border-hairline pt-2 sm:gap-3">
        {bars.map((b) => (
          <div key={b.key} className="min-w-0 flex-1">
            <div className={cn(
              "font-mono text-[12px] tabular-nums leading-tight",
              b.direction === "down" ? "text-rose" : b.direction === "total" ? "text-ink font-semibold" : "text-amber-ink",
            )}>
              {b.direction === "down" ? "−" : ""}{rupee(b.magnitude, { compact: true })}
            </div>
            <div className="truncate text-[11px] text-ink-2" title={b.label}>{b.label}</div>
            {b.hint && (
              <div className="text-[10px] leading-tight text-ink-3">{b.hint}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
