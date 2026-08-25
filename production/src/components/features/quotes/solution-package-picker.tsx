"use client";

/**
 * 1-click solution packages — "Google Workspace + Backup + SSL" in one action.
 *
 * The interesting part of this component is what it does when the tenant's catalogue
 * is incomplete. It resolves against the REAL catalogue and shows, per package, which
 * components it found and which it could not, BEFORE the rep clicks. A package that
 * silently added two of its three products would produce a quote that looks finished
 * and under-sells by one line — so an incomplete package is still clickable, but it
 * says exactly what will be missing and where to fix it.
 */
import * as React from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn, rupee } from "@/lib/utils";
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";
import { SOLUTION_BUNDLES, resolveBundle, bundleGapMessage, type ResolvedBundle } from "@/lib/quotes/bundles";
import { slabPricing } from "@/lib/quotes/volume-tiers";

export function SolutionPackagePicker({
  open, onOpenChange, catalog, seats, onAdd, startDate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: Item[];
  /** Seat count the per-seat components are sized to. */
  seats: number;
  onAdd: (lines: QuoteLineItem[]) => void;
  startDate?: string;
}) {
  const seatCount = Math.max(1, Math.trunc(seats) || 1);

  const resolvedAll = React.useMemo(
    () => SOLUTION_BUNDLES.map((b) => resolveBundle(b, catalog, seatCount)),
    [catalog, seatCount],
  );

  const addBundle = (r: ResolvedBundle) => {
    if (r.resolved.length === 0) {
      toast.error(`Nothing in "${r.bundle.name}" is in your catalogue.`, {
        description: bundleGapMessage(r) ?? undefined,
      });
      return;
    }

    const lines: QuoteLineItem[] = r.resolved.map((rc, i) => {
      /* Each component is priced at its OWN seat count — a fixed-qty SSL certificate
         must not be priced in the volume band the 25 mail seats earned. */
      const priced = slabPricing(rc.item, rc.qty);
      const rate = Math.round(priced.msrpPerSeatMonth * 12);
      return {
        id: `line-${Date.now()}-${i}`,
        item_id: rc.item.id,
        name: rc.item.name,
        qty: rc.qty,
        rate,
        list_rate: rate,
        cost: Math.round(priced.wholesalePerSeatMonth * 12),
        commitment: "annual_yearly",
        ...(startDate ? { start_date: startDate } : {}),
      };
    });

    onAdd(lines);
    onOpenChange(false);

    const gap = bundleGapMessage(r);
    if (gap) {
      toast.warning(`Added ${lines.length} of ${r.bundle.components.length} — the rest is missing`, {
        description: gap,
        duration: 10_000,
      });
    } else {
      toast.success(`${r.bundle.name} added — ${lines.length} lines.`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Solution packages</DialogTitle>
          <DialogDescription>
            One click adds every product in the package, priced for {seatCount} {seatCount === 1 ? "seat" : "seats"}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {resolvedAll.map((r) => {
            const total = r.resolved.reduce((s, rc) => {
              const p = slabPricing(rc.item, rc.qty);
              return s + Math.round(p.msrpPerSeatMonth * 12) * rc.qty;
            }, 0);

            return (
              <div key={r.bundle.id} className="rounded-lg border border-hairline bg-paper p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink">{r.bundle.name}</p>
                    <p className="mt-0.5 text-2xs leading-snug text-ink-3">{r.bundle.pitch}</p>
                  </div>
                  {total > 0 && (
                    <p className="shrink-0 font-serif text-[15px] font-semibold text-ink tabular-nums">
                      {rupee(total)}<span className="ml-0.5 font-sans text-3xs font-normal text-ink-3">/yr</span>
                    </p>
                  )}
                </div>

                <ul className="mt-2.5 space-y-1">
                  {r.bundle.components.map((c) => {
                    const hit  = r.resolved.find((x) => x.component === c);
                    const miss = r.unresolved.find((x) => x.component === c);
                    return (
                      <li key={c.label} className="flex items-start gap-1.5 text-2xs leading-snug">
                        <Icon
                          name={hit ? "check" : "alert"}
                          size={11}
                          className={cn("mt-[3px] shrink-0", hit ? "text-emerald" : c.required ? "text-rose" : "text-ink-3")}
                        />
                        {hit ? (
                          <span className="text-ink-2">
                            {hit.item.name} <span className="text-ink-3">× {hit.qty}</span>
                          </span>
                        ) : (
                          <span className={c.required ? "text-rose" : "text-ink-3"}>
                            {c.label} — {miss?.reason === "ambiguous"
                              ? `${miss.candidates?.length} rows match at the same price, pick one by hand`
                              : "not in your catalogue"}
                            {!c.required && " (optional)"}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>

                <button
                  type="button"
                  onClick={() => addBundle(r)}
                  disabled={r.resolved.length === 0}
                  className={cn(
                    "mt-3 w-full rounded-md px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                    r.resolved.length === 0
                      ? "cursor-not-allowed bg-paper-2 text-ink-3"
                      : r.complete
                        ? "bg-amber text-white hover:bg-amber/90"
                        : "border border-amber/60 bg-amber-soft text-amber-ink hover:bg-amber-soft/70",
                  )}
                >
                  {r.resolved.length === 0
                    ? "Nothing to add"
                    : r.complete
                      ? `Add all ${r.resolved.length}`
                      : `Add ${r.resolved.length} of ${r.bundle.components.length}`}
                </button>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
