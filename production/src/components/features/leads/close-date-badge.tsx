"use client";
/**
 * "Band: 15 Oct" — a deal's expected close date on a card or row (lib/leads/deal-rules.ts).
 * An OPEN deal past its date turns rose and says "overdue" in words, not only in colour.
 * Renders nothing for a lost deal or one with no date.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { closeDateShort, isCloseOverdue } from "@/lib/leads/deal-rules";
import { istToday } from "@/lib/dates/ist";
import { cn } from "@/lib/utils";

export function CloseDateBadge({ lead, className }: {
  lead: Pick<Lead, "stage" | "expected_close_date">;
  className?: string;
}) {
  if (!lead.expected_close_date || lead.stage === "lost") return null;
  const overdue = isCloseOverdue(lead, istToday());
  return (
    <span
      title={overdue ? "Overdue — update date" : "Expected close"}
      className={cn("tabular-nums whitespace-nowrap", overdue ? "font-semibold text-rose" : "text-ink-3", className)}
    >
      Close: {closeDateShort(lead.expected_close_date)}{overdue ? " · overdue" : ""}
    </span>
  );
}
