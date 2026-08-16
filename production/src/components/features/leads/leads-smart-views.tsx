/**
 * LeadsSmartViews — saved filter views, as a single dropdown.
 *
 * WAS a horizontal chip bar. On the Sales & Pipeline toolbar it sat in a
 * `flex-1 min-w-0 overflow-x-auto` between the search box and the view/filter
 * buttons, and with up to eight chips competing for what was left, the strip
 * collapsed to showing ONE chip with scroll arrows either side. At that width it
 * was worse than a dropdown in every way: you could not see which views existed,
 * could not read their counts, and had to scrub sideways to find anything.
 *
 * WHAT A NAIVE CONVERSION WOULD BREAK. The counts were the point — the chips
 * existed so a rep could read the pipeline without clicking. Putting them behind
 * a trigger hides exactly the information the component was built to surface.
 *
 * So the trigger is not just a label. It carries:
 *   • the active view and its count, so the current filter is always legible; and
 *   • an OVERDUE badge whenever follow-ups have slipped and you are not already
 *     looking at them. Overdue is the one bucket that is time-critical — a
 *     duplicate can wait a week, a follow-up two days late cannot — so it is the
 *     one number that must survive being collapsed.
 *
 * Views:
 *   All · Mine · Today (arrived today) · Overdue · Hot · New
 *   Duplicates and Junk appear only when they have something in them.
 *
 * @example
 *   <LeadsSmartViews leads={leads} currentUserId={me.userId} active={view} onChange={setView} />
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isHotLead } from "@/lib/leads/heat";
import { localDateISO } from "@/lib/leads/outcomes";
import { staleDeals, STAGE_SLA_DAYS } from "@/lib/leads/velocity";
import type { Lead } from "@/lib/supabase/database.types";

export type SmartView = "all" | "mine" | "today" | "overdue" | "hot" | "new" | "closing" | "stalled" | "won-mtd" | "duplicates" | "junk";

interface LeadsSmartViewsProps {
  leads: Lead[];
  /** Current user's UUID — used to compute "Mine" count. */
  currentUserId?: string;
  /** Count of leads flagged as likely duplicates (computed on the page). The
   *  Duplicates entry only appears when this is > 0 — no noise when clean. */
  duplicateCount?: number;
  /** Count of leads marked junk. Junk shows when > 0 (or suspects exist). */
  junkCount?: number;
  /** Count of NON-junk leads the heuristic suspects as junk — nudges review. */
  junkSuspectCount?: number;
  active: SmartView;
  onChange: (view: SmartView) => void;
}

type Tone = "default" | "amber" | "rose";

interface ViewDef {
  id: SmartView;
  label: string;
  count?: number;
  tone: Tone;
  /** One line explaining what the view holds — shown under the label. */
  hint: string;
}

export function LeadsSmartViews({
  leads, currentUserId, duplicateCount = 0, junkCount = 0, junkSuspectCount = 0, active, onChange,
}: LeadsSmartViewsProps) {
  const today = new Date().toISOString().slice(0, 10);

  // ── Counts ────────────────────────────────────────────────────────────────
  // Working views never count junk — it lives only under the Junk view.
  const working  = leads.filter((l) => !l.is_junk);
  const all      = working.length;
  const mine     = currentUserId ? working.filter((l) => l.owner_id === currentUserId).length : 0;
  // Leads that ARRIVED today (created today) — matches the operator's mental
  // model of "what came in today?". Follow-up due belongs to Overdue.
  const todayDue = working.filter((l) => l.created_at?.slice(0, 10) === today).length;
  // Overdue = follow-up date in the past, still open. The most actionable bucket
  // for a rep, which is why it also shows on the trigger.
  const overdue  = working.filter((l) => l.follow_up_date && l.follow_up_date < today && l.stage !== "won" && l.stage !== "lost").length;
  // "Hot" = priority high OR late-funnel stage — same isHotLead the row tags
  // use, so the count always matches the number of Hot-tagged rows.
  const hot      = working.filter(isHotLead).length;
  const newCt    = working.filter((l) => l.stage === "new").length;
  /* Month end via localDateISO, not a local copy of the same formatting. toISOString()
     before 05:30 IST returns the previous day, which at a month boundary silently drops
     a whole month of deals — and a second implementation is a second place for that bug
     to come back. */
  const monthEnd = (() => {
    const d = new Date();
    return localDateISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  })();
  /* Stalled = open and sitting in the same stage past the SLA. Deals with no recorded
     stage-change date are NOT counted — the code cannot claim they are stale without
     knowing when they last moved, and updated_at will not do (it bumps on any edit). */
  const stalledCt = staleDeals(working).length;
  const closingCt = working.filter((l) =>
    l.expected_close_date && l.expected_close_date <= monthEnd &&
    l.stage !== "won" && l.stage !== "lost").length;

  const views: ViewDef[] = [
    { id: "all",   label: "All",     count: all,      tone: "default", hint: "Everything except junk" },
    ...(currentUserId
      ? [{ id: "mine" as SmartView, label: "Mine", count: mine, tone: "default" as Tone, hint: "Assigned to you" }]
      : []),
    { id: "today", label: "Today",   count: todayDue, tone: "amber",   hint: "Arrived today" },
    { id: "overdue", label: "Overdue", count: overdue, tone: "rose",   hint: "Follow-up date has passed" },
    { id: "hot",   label: "Hot",     count: hot,      tone: "default", hint: "High priority or late-stage" },
    { id: "new",   label: "New",     count: newCt,    tone: "default", hint: "Not contacted yet" },
    /* Closing this month — the forecast cut. Deliberately EXCLUDES deals with no
       expected close date: "closing this month" is a claim, and a deal nobody has dated
       has not made it. Those show up as "undated" in the KPI strip instead. */
    { id: "stalled", label: "Stalled", count: stalledCt, tone: "rose",
      hint: `No stage movement for ${STAGE_SLA_DAYS}+ days — needs a nudge` },
    { id: "closing", label: "Closing this month", count: closingCt, tone: "amber",
      hint: "Expected to close on or before month end — undated deals are not counted" },
  ];

  // Cleanup views — present only when there is something to clean, so the menu
  // stays short on a tidy pipeline.
  const cleanup: ViewDef[] = [];
  if (duplicateCount > 0) {
    cleanup.push({ id: "duplicates", label: "Duplicates", count: duplicateCount, tone: "rose", hint: "Same company or contact twice" });
  }
  if (junkCount > 0 || junkSuspectCount > 0) {
    cleanup.push({
      id: "junk",
      label: "Junk",
      count: junkCount > 0 ? junkCount : undefined,
      tone: "rose",
      hint: junkSuspectCount > 0 && junkCount === 0 ? `${junkSuspectCount} suspected — review` : "Marked as junk",
    });
  }

  const activeDef = [...views, ...cleanup].find((v) => v.id === active);
  // Fallback covers "won-mtd", which the page can set but this menu doesn't list.
  const activeLabel = activeDef?.label ?? "Custom view";

  // The signal that must not be lost to the collapse. Suppressed while the user
  // is already in Overdue — telling someone what they are looking at is noise.
  const showOverdueAlert = overdue > 0 && active !== "overdue";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* "outline" once a view is applied, so a filtered pipeline is visibly
            filtered from across the room — the old chip bar signalled that with
            an amber active chip, and losing it would let someone read a filtered
            list as the whole pipeline. */}
        <Button size="sm" variant={active === "all" ? "ghost" : "outline"} className="shrink-0">
          <Icon name="eye" size={13} className="text-ink-3" />
          <span className="font-medium">{activeLabel}</span>
          {activeDef?.count !== undefined && (
            <span className="text-[10px] tabular-nums opacity-70">{activeDef.count}</span>
          )}
          {showOverdueAlert && (
            <span
              className="ml-0.5 inline-flex items-center gap-1 rounded-full bg-rose-soft px-1.5 py-0.5 text-[10px] font-semibold text-rose tabular-nums"
              title={`${overdue} lead${overdue === 1 ? "" : "s"} past their follow-up date`}
            >
              {overdue} overdue
            </span>
          )}
          <Icon name="chevron_down" size={12} className="text-ink-3" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-ink-3">
          Views
        </DropdownMenuLabel>
        {views.map((v) => (
          <ViewRow key={v.id} view={v} active={v.id === active} onSelect={() => onChange(v.id)} />
        ))}
        {cleanup.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-ink-3">
              Needs cleanup
            </DropdownMenuLabel>
            {cleanup.map((v) => (
              <ViewRow key={v.id} view={v} active={v.id === active} onSelect={() => onChange(v.id)} />
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewRow({ view, active, onSelect }: { view: ViewDef; active: boolean; onSelect: () => void }) {
  // Zero is stated rather than hidden: "Overdue 0" is a useful, reassuring fact,
  // and a row whose count vanishes reads as broken.
  const countTone =
    view.count === 0 ? "text-ink-3"
    : view.tone === "rose" ? "text-rose"
    : view.tone === "amber" ? "text-amber-ink"
    : "text-ink-2";

  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-2 py-1.5">
      {/* Fixed-width slot so labels line up whether or not a row is checked. */}
      <span className="w-3.5 shrink-0">
        {active && <Icon name="check" size={13} className="text-amber" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-xs", active ? "font-semibold text-ink" : "text-ink-2")}>
          {view.label}
        </span>
        <span className="block text-[10px] text-ink-3">{view.hint}</span>
      </span>
      {view.count !== undefined && (
        <span className={cn("text-xs font-semibold tabular-nums shrink-0", countTone)}>
          {view.count}
        </span>
      )}
    </DropdownMenuItem>
  );
}
