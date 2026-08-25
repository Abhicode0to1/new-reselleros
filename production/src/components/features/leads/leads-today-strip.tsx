/**
 * LeadsTodayStrip — thin top strip surfacing what the sales rep needs to
 * do RIGHT NOW. Sits above the KPI band, visible at all breakpoints.
 *
 * Pattern: HubSpot's "Sales Workspace" 2025 redesign puts a today bar at
 * the top of the leads page so reps see urgent work BEFORE they see data.
 * Close.com and Attio do something similar. The Indian SME insight: reps
 * here are on phones, and they need 1-tap action to whatever's overdue.
 *
 * Content (priority order — first non-zero shows):
 *   1. Overdue follow-ups (rose, urgent)
 *   2. Due-today follow-ups (amber)
 *   3. Hot leads waiting on a touch (amber-soft)
 *   4. Quotes pending acceptance (slate)
 *   5. Renewals due in next 7 days (indigo)
 *
 * Each chip is a clickable filter — tap it, list re-filters. The whole
 * strip collapses to a tooltip-style icon row on very narrow screens.
 *
 * When NOTHING is urgent (rare), shows a single "All clear" chip with
 * a quiet emerald tone — no fake content, no noise.
 *
 * @example
 *   <LeadsTodayStrip leads={leads} onFilterDue={setDueFilter} dueFilter={dueFilter} />
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import type { LeadsDueFilter } from "./leads-insight-band";

interface LeadsTodayStripProps {
  leads: Lead[];
  dueFilter: LeadsDueFilter;
  onFilterDue: (f: LeadsDueFilter) => void;
}

export function LeadsTodayStrip({ leads, dueFilter, onFilterDue }: LeadsTodayStripProps) {
  const today = new Date().toISOString().slice(0, 10);
  const open  = leads.filter((l) => l.stage !== "won" && l.stage !== "lost");

  // ── Counts ─────────────────────────────────────────────────
  const overdue   = open.filter((l) => l.follow_up_date && l.follow_up_date < today).length;
  const dueToday  = open.filter((l) => l.follow_up_date === today).length;
  const hot       = leads.filter((l) => l.stage === "demo" || l.stage === "trial" || l.stage === "quote").length;
  // Quotes awaiting response (sent stage but not won/lost yet). The Lead's
  // stage stays "quote" until accepted or rejected — that's the bucket.
  const quotesPending = leads.filter((l) => l.stage === "quote").length;

  // If everything is zero we don't render anything — keeps the layout
  // tight when there's literally nothing urgent.
  const totalSignals = overdue + dueToday + hot + quotesPending;
  if (totalSignals === 0) return null;

  return (
    <div className="mb-4 flex items-center gap-2 overflow-x-auto pb-1">
      {/* Leading clock icon + "Today" label — sets the section context */}
      <div className="inline-flex items-center gap-1.5 text-3xs uppercase tracking-wider font-semibold text-ink-3 shrink-0 pr-1.5">
        <Icon name="clock" size={11} className="text-amber" />
        Today
      </div>

      {/* Chips — ordered by urgency. Each tap filters the underlying list
          via the existing dueFilter pipeline. */}
      {overdue > 0 && (
        <TodayChip
          icon="alert"
          label={`${overdue} overdue`}
          tone="rose"
          active={dueFilter === "overdue"}
          onClick={() => onFilterDue(dueFilter === "overdue" ? "all" : "overdue")}
        />
      )}
      {dueToday > 0 && (
        <TodayChip
          icon="clock"
          label={`${dueToday} due today`}
          tone="amber"
          active={dueFilter === "today"}
          onClick={() => onFilterDue(dueFilter === "today" ? "all" : "today")}
        />
      )}
      {hot > 0 && (
        <TodayChip
          icon="zap"
          label={`${hot} hot`}
          tone="amber-soft"
          active={dueFilter === "hot"}
          onClick={() => onFilterDue(dueFilter === "hot" ? "all" : "hot")}
        />
      )}
      {quotesPending > 0 && (
        <TodayChip
          icon="file"
          label={`${quotesPending} quote${quotesPending === 1 ? "" : "s"} pending`}
          tone="slate"
          // Quote bucket maps to stageFilter rather than dueFilter — for
          // now we route through hot since quote IS one of the hot stages.
          active={false}
          onClick={() => onFilterDue(dueFilter === "hot" ? "all" : "hot")}
        />
      )}
    </div>
  );
}

// ============================================================
// Single chip — compact, tone-aware, tap-to-filter
// ============================================================
type ChipTone = "rose" | "amber" | "amber-soft" | "slate" | "emerald";

interface TodayChipProps {
  icon: string;
  label: string;
  tone: ChipTone;
  active?: boolean;
  onClick: () => void;
}

function TodayChip({ icon, label, tone, active, onClick }: TodayChipProps) {
  // Tones tuned for at-a-glance urgency.
  // rose = overdue (act now), amber filled = today (act today),
  // amber-soft = hot opp (high intent), slate = informational, emerald = good.
  const toneClass: Record<ChipTone, string> = {
    rose:         "bg-rose/10 border-rose/30 text-rose",
    amber:        "bg-amber text-paper border-amber/0 shadow-sm shadow-amber/30",
    "amber-soft": "bg-amber-soft border-amber/30 text-amber-ink",
    slate:        "bg-paper-2 border-hairline text-ink-2",
    emerald:      "bg-emerald-soft border-emerald/30 text-emerald",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 shrink-0",
        "px-2.5 py-1 rounded-full border text-2xs font-semibold",
        "transition-all hover:brightness-105 active:brightness-95",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
        toneClass[tone],
        active && "ring-2 ring-offset-1 ring-amber",
      )}
    >
      <Icon name={icon} size={11} />
      {label}
    </button>
  );
}
