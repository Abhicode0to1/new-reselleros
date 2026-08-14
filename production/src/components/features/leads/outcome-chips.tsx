/**
 * OutcomeChips — the 1-tap call-outcome row.
 *
 * One component used by the list row, the mobile card and the call queue, so a rep
 * learns four chips once. What each chip does lives in lib/leads/outcomes.ts; this file
 * only renders it.
 *
 * Two behaviours worth knowing:
 *   • The "No answer" chip is DISABLED with a reason when the lead has no phone. A chip
 *     that logs "no answer" for a number that was never dialled is a false record.
 *   • Every chip carries its `hint` as a title, so nothing here is a mystery button
 *     (CLAUDE.md §24).
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { OUTCOME_CHIPS, type LeadOutcome } from "@/lib/leads/outcomes";

const TONE: Record<"default" | "amber" | "rose", string> = {
  default: "border-hairline-strong text-ink-2 hover:bg-paper-2",
  amber:   "border-amber/50 text-amber-ink hover:bg-amber-soft/50",
  rose:    "border-rose/50 text-rose hover:bg-rose-soft/50",
};

export function OutcomeChips({
  hasPhone, onPick, size = "sm", className,
}: {
  hasPhone: boolean;
  onPick: (outcome: LeadOutcome) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {OUTCOME_CHIPS.map((chip) => {
        const blocked = chip.needsPhone && !hasPhone;
        return (
          <button
            key={chip.id}
            type="button"
            disabled={blocked}
            title={blocked ? `${chip.hint}\n\nNo phone number on this lead — add one first.` : chip.hint}
            aria-label={chip.label}
            /* Stops the row's own click handler from opening the drawer underneath.
               Without this every chip tap ALSO opens the lead, which on mobile means
               the sheet covers the confirmation the rep needs to read. */
            onClick={(e) => { e.stopPropagation(); onPick(chip.id); }}
            onPointerDown={(e) => e.stopPropagation()}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border font-semibold transition-colors",
              size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-3 py-1.5 text-xs",
              // 44px touch target on the md size — thumbs, per §20.
              size === "md" && "min-h-[38px]",
              blocked ? "cursor-not-allowed border-hairline text-ink-3 opacity-50" : TONE[chip.tone],
            )}
          >
            <Icon name={chip.icon} size={size === "sm" ? 11 : 13} />
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
