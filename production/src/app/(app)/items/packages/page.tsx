/**
 * Packages — the tenant's own bundles of catalogue items (2 Oct 2026).
 * Owner / manager create and edit; everyone sees what reps can quote.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useItems } from "@/lib/queries/items";
import { usePackages, useDeletePackage } from "@/lib/queries/packages";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useConfirm } from "@/components/providers/confirm-provider";
import { PackageEditor } from "@/components/features/packages/package-editor";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { rupee, cn } from "@/lib/utils";
import { pricePackage, missingMessage, type PackageRow } from "@/lib/packages/price";

export default function PackagesPage() {
  const { data: packages, isLoading } = usePackages({ includeInactive: true });
  const { data: catalog } = useItems({ includeInactive: true });
  const { data: me } = useCurrentUser();
  const del = useDeletePackage();
  const confirm = useConfirm();
  const canEdit = me?.role === "owner" || me?.role === "manager";

  const [seats, setSeats] = React.useState(10);
  const [editing, setEditing] = React.useState<PackageRow | null>(null);
  const [open, setOpen] = React.useState(false);

  const items = catalog ?? [];
  const nameOf = (id: string) => items.find((c) => c.id === id)?.name;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1200px] mx-auto space-y-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <Link href="/items" className="text-xs text-ink-3 hover:text-ink">← Catalog</Link>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight mt-1">Packages</h1>
          <p className="text-sm text-ink-3 mt-1">Bundles a rep adds to a quote in one tap — priced live from your catalogue.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-ink-3">Price for</span>
            <input type="number" min={1} value={seats} aria-label="Seats for the price"
              onChange={(e) => setSeats(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="w-16 rounded-md border border-hairline bg-paper px-2 py-1 text-sm tabular-nums" />
            <span className="text-ink-3">seats</span>
          </label>
          {canEdit ? (
            <Button variant="primary" icon="plus" onClick={() => { setEditing(null); setOpen(true); }}>New package</Button>
          ) : (
            <span className="text-xs text-ink-3">Only an owner or manager can change packages.</span>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : !packages || packages.length === 0 ? (
        <EmptyState
          icon="package"
          title="No packages yet"
          body="Put licences, support and a domain together once; every rep can then quote the set in one tap."
          action={canEdit ? <Button variant="primary" icon="plus" onClick={() => { setEditing(null); setOpen(true); }}>Create a package</Button> : undefined}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {packages.map((pkg) => {
            const priced = pricePackage(pkg, items, seats);
            const gap = missingMessage(priced, nameOf);
            return (
              <div key={pkg.id} className={cn("rounded-lg border bg-paper p-4 flex flex-col", !pkg.is_active && "opacity-60", gap ? "border-amber/50" : "border-hairline")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-ink">{pkg.name}</span>
                      {!pkg.is_active && <Badge size="sm" kind="muted">Hidden</Badge>}
                      {pkg.discount_pct > 0 && <Badge size="sm" kind="success">{pkg.discount_pct}% off</Badge>}
                    </div>
                    {pkg.pitch && <p className="text-2xs text-ink-3 mt-0.5">{pkg.pitch}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-serif text-xl tabular-nums">{rupee(priced.total)}<span className="text-3xs text-ink-3 font-sans">/yr</span></div>
                    {priced.saving > 0 && <div className="text-2xs text-emerald">saves {rupee(priced.saving)}</div>}
                  </div>
                </div>
                <ul className="mt-3 space-y-1 text-xs flex-1">
                  {priced.parts.map((pp) => (
                    <li key={pp.item.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-ink-2">{pp.item.name}{pp.part.optional && <span className="ml-1 text-3xs text-ink-3">optional</span>}</span>
                      <span className="tabular-nums text-ink-3 shrink-0">{pp.part.qty_mode === "fixed" ? pp.qty : `${pp.qty} seats`} × {rupee(pp.rate)}</span>
                    </li>
                  ))}
                </ul>
                {gap && <p className="mt-2 text-2xs text-amber-ink">⚠ {gap}</p>}
                <div className="mt-3 pt-3 border-t border-hairline flex items-center justify-between">
                  <span className="text-3xs text-ink-3">{priced.marginPct !== null ? `Est. margin ${priced.marginPct}%` : ""}</span>
                  {canEdit && (
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="ghost" icon="trash"
                        onClick={async () => { if (await confirm({ title: `Delete ${pkg.name}?`, body: "Quotes already made with it are not changed.", danger: true, confirmLabel: "Delete" })) del.mutate(pkg.id); }}>
                        Delete
                      </Button>
                      <Button size="sm" variant="default" icon="edit" onClick={() => { setEditing(pkg); setOpen(true); }}>Edit</Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PackageEditor open={open} onOpenChange={setOpen} initial={editing} catalog={items} />
    </div>
  );
}
