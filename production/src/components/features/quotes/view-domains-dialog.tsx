/**
 * ViewDomainsDialog — read-only popup listing the domains on a bulk quote line.
 * Used so a 1000-domain order doesn't blow up the quote-builder row layout: the
 * row stays compact and "view" opens this scrollable, searchable modal.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  planName: string;
  domains: Array<{ domain: string; seats: number }>;
}

export function ViewDomainsDialog({ open, onOpenChange, planName, domains }: Props) {
  const [q, setQ] = React.useState("");
  React.useEffect(() => { if (!open) setQ(""); }, [open]);

  const totalSeats = domains.reduce((s, d) => s + d.seats, 0);
  const filtered = q.trim()
    ? domains.filter((d) => d.domain.toLowerCase().includes(q.trim().toLowerCase()))
    : domains;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">{planName} — {domains.length} domains</DialogTitle>
          <DialogDescription>{totalSeats} seats total · one subscription per domain is created on payment.</DialogDescription>
        </DialogHeader>

        <Input
          type="search"
          placeholder="Search domains…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        <div className="mt-2 max-h-[55vh] overflow-y-auto rounded-md border border-hairline divide-y divide-hairline">
          {filtered.length === 0 ? (
            <p className="p-4 text-sm text-ink-3 text-center">No domains match "{q}".</p>
          ) : (
            filtered.map((d) => (
              <div key={d.domain} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                <span className="font-mono text-[12px] text-ink truncate">{d.domain}</span>
                <span className="tabular-nums text-ink-3 shrink-0">{d.seats} seats</span>
              </div>
            ))
          )}
        </div>
        {q.trim() && (
          <p className="mt-1 text-2xs text-ink-3">{filtered.length} of {domains.length} shown</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
