"use client";

/**
 * What has changed on this contract, and when.
 *
 * ─── THE ANSWER TO "WE NEVER AGREED TO 30 SEATS" ────────────────────────────
 * Before this, a rep could change seats or the plan in "Correct details" and nothing
 * recorded what it had been. In a dispute the only evidence was the current row,
 * which agrees with the invoice and with nobody's memory.
 *
 * Rows come from a Postgres trigger and cannot be edited — see migration
 * 20260816170000 for the precise sense in which that is "immutable".
 *
 * ─── IT REPORTS A MISMATCH RATHER THAN HIDING ONE ───────────────────────────
 * If the ledger's last seat figure does not match the subscription, seats moved
 * without the trigger seeing it. That should be impossible, which is exactly why it
 * is checked and shown rather than assumed.
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { cn, formatDate } from "@/lib/utils";
import type { ContractAmendment } from "@/lib/supabase/database.types";
import { describeAmendment, amendmentActor, seatHistoryReconciles } from "@/lib/subscriptions/amendments";

const TONE_CLASS = {
  increase: "text-emerald",
  decrease: "text-amber-ink",
  warning:  "text-rose",
  neutral:  "text-ink-2",
} as const;

export function AmendmentHistory({ amendments, currentSeats }: {
  amendments: ContractAmendment[];
  currentSeats: number;
}) {
  const reconciles = React.useMemo(
    () => seatHistoryReconciles(amendments, currentSeats),
    [amendments, currentSeats],
  );

  if (amendments.length === 0) {
    return (
      <div className="mt-4 border-t border-hairline pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Contract changes</p>
        <p className="mt-1 text-sm text-ink-3">
          Nothing has changed on this contract since the ledger started.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-hairline pt-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Contract changes</p>
        <span className="text-[10px] text-ink-3">{amendments.length} recorded · cannot be edited</span>
      </div>

      {reconciles === false && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-rose/40 bg-rose-soft/40 px-2.5 py-1.5">
          <Icon name="alert" size={11} className="mt-[3px] shrink-0 text-rose" />
          <p className="text-[11px] leading-snug text-ink-2">
            The last recorded seat count does not match this subscription&apos;s {currentSeats}.
            Seats moved without being recorded — worth looking into before relying on this history.
          </p>
        </div>
      )}

      <ol className="mt-2 space-y-2.5">
        {amendments.map((a) => {
          const lines = describeAmendment(a);
          return (
            <li key={a.id} className="flex gap-2.5">
              <div className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-hairline-strong" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[11px] font-medium text-ink-2">{formatDate(a.created_at)}</span>
                  {a.source === "system" && <Badge kind="muted" size="sm">automatic</Badge>}
                </div>
                {lines.map((l) => (
                  <p key={l.text} className={cn("text-[12px] leading-snug", TONE_CLASS[l.tone])}>
                    {l.text}
                  </p>
                ))}
                <p className="text-[10px] text-ink-3">{amendmentActor(a)}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
