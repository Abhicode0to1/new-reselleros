"use client";

/**
 * Package picker on the quote (2 Oct 2026, rebuilt on the tenant's own packages).
 *
 * Each card is priced live from the catalogue for the seat count in the box: every
 * part with its qty × rate, the total, what the package discount saves, and the margin.
 * A part that has left the catalogue is named before the click, never silently
 * dropped — a package that adds two of its three parts looks finished and under-sells.
 */
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, rupee } from "@/lib/utils";
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";
import { usePackages } from "@/lib/queries/packages";
import { pricePackage, packageLines, missingMessage, type PackageRow } from "@/lib/packages/price";

export function SolutionPackagePicker({
  open, onOpenChange, catalog, seats, onAdd, startDate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: Item[];
  /** Seat count the per-seat parts start at; editable in the dialog. */
  seats: number;
  onAdd: (lines: QuoteLineItem[]) => void;
  startDate?: string;
}) {
  const { data: packages, isLoading } = usePackages();
  const [seatCount, setSeatCount] = React.useState(Math.max(1, Math.trunc(seats) || 1));
  React.useEffect(() => { if (open) setSeatCount(Math.max(1, Math.trunc(seats) || 1)); }, [open, seats]);
  /* Optional parts the rep left out, per package. Default: everything in. */
  const [skipped, setSkipped] = React.useState<Record<string, Set<string>>>({});

  const nameOf = React.useCallback((id: string) => catalog.find((c) => c.id === id)?.name, [catalog]);

  const add = (pkg: PackageRow) => {
    const skip = skipped[pkg.id] ?? new Set<string>();
    const trimmed: PackageRow = { ...pkg, items: pkg.items.filter((i) => !(i.optional && skip.has(i.item_id))) };
    const priced = pricePackage(trimmed, catalog, seatCount);
    if (priced.parts.length === 0) {
      toast.error(`Nothing in "${pkg.name}" is active in your catalogue.`, { description: missingMessage(priced, nameOf) ?? undefined });
      return;
    }
    onAdd(packageLines(priced, { startDate }));
    onOpenChange(false);
    const gap = missingMessage(priced, nameOf);
    if (gap) {
      toast.warning(`Added ${priced.parts.length} of ${pkg.items.length} — the rest is missing`, { description: gap, duration: 10_000 });
    } else {
      toast.success(`${pkg.name} added — ${priced.parts.length} lines, ${rupee(priced.total)}/yr.`);
    }
  };

  const toggleOptional = (pkgId: string, itemId: string) => {
    setSkipped((s) => {
      const next = new Set(s[pkgId] ?? []);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return { ...s, [pkgId]: next };
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Add a package</DialogTitle>
          <DialogDescription>Everything the customer needs in one tap, priced from your catalogue.</DialogDescription>
        </DialogHeader>

        <div className="px-6 pt-3 flex items-center justify-between gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-ink-3">Seats</span>
            <input
              type="number" min={1} value={seatCount}
              onChange={(e) => setSeatCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
              aria-label="Seats for the package"
              className="w-20 rounded-md border border-hairline bg-paper px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-amber/40"
            />
          </label>
          <Link href="/items/packages" className="text-xs text-amber-ink hover:underline">Manage packages →</Link>
        </div>

        <div className="px-6 py-4 max-h-[65vh] overflow-y-auto space-y-3">
          {isLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full" />)
          ) : !packages || packages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-hairline p-6 text-center">
              <p className="font-medium text-ink">No packages yet</p>
              <p className="text-sm text-ink-3 mt-1">Make one — licences, support, a domain — and add it to any quote in one tap.</p>
              <Link href="/items/packages" className="inline-block mt-3 text-sm font-medium text-amber-ink hover:underline">Create a package →</Link>
            </div>
          ) : (
            packages.map((pkg) => {
              const skip = skipped[pkg.id] ?? new Set<string>();
              const priced = pricePackage({ ...pkg, items: pkg.items.filter((i) => !(i.optional && skip.has(i.item_id))) }, catalog, seatCount);
              const gap = missingMessage(priced, nameOf);
              const optionalParts = pkg.items.filter((i) => i.optional && catalog.some((c) => c.id === i.item_id && c.is_active !== false));
              return (
                <div key={pkg.id} className={cn("rounded-lg border bg-paper p-4", priced.complete ? "border-hairline" : "border-amber/50")}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-ink">{pkg.name}</div>
                      {pkg.pitch && <p className="text-2xs text-ink-3 mt-0.5">{pkg.pitch}</p>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-serif text-lg tabular-nums text-ink">{rupee(priced.total)}<span className="text-3xs text-ink-3 font-sans">/yr</span></div>
                      {priced.saving > 0 && (
                        <div className="text-2xs text-emerald tabular-nums">
                          <s className="text-ink-3">{rupee(priced.listTotal)}</s> · save {rupee(priced.saving)} ({pkg.discount_pct}%)
                        </div>
                      )}
                    </div>
                  </div>

                  <ul className="mt-2.5 space-y-1">
                    {priced.parts.map((pp) => (
                      <li key={pp.item.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate text-ink-2">
                          {pp.part.optional && (
                            <input
                              type="checkbox" checked aria-label={`Include ${pp.item.name}`}
                              onChange={() => toggleOptional(pkg.id, pp.item.id)}
                              className="mr-1.5 align-middle accent-amber"
                            />
                          )}
                          {pp.item.name}
                          {pp.part.optional && <span className="ml-1 text-3xs text-ink-3">optional</span>}
                        </span>
                        <span className="shrink-0 tabular-nums text-ink-3">{pp.qty} × {rupee(pp.rate)}</span>
                      </li>
                    ))}
                    {optionalParts.filter((o) => skip.has(o.item_id)).map((o) => (
                      <li key={o.item_id} className="flex items-center gap-2 text-xs text-ink-3">
                        <input type="checkbox" checked={false} aria-label={`Include ${nameOf(o.item_id)}`} onChange={() => toggleOptional(pkg.id, o.item_id)} className="accent-amber" />
                        <span className="line-through">{nameOf(o.item_id)}</span>
                      </li>
                    ))}
                  </ul>

                  {gap && <p className="mt-2 text-2xs text-amber-ink">⚠ {gap}</p>}

                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="text-3xs text-ink-3">{priced.marginPct !== null ? `Est. margin ${priced.marginPct}%` : ""}</span>
                    <Button size="sm" variant="primary" icon="plus" onClick={() => add(pkg)}>Add to quote</Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
