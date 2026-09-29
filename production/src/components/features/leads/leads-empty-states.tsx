"use client";
/**
 * Error / loading / empty / nothing-matches states for Sales & Pipeline — moved verbatim out
 * of (app)/leads/page.tsx (S35, 28 Sep 2026). Two components because they sit at two places
 * in the page: the status block above the board/list, and the no-results hint below it.
 *
 * S40: counts in, not lead arrays — `totalLeads` (lead_counts().pool.total: does the
 * workspace have ANY lead) and `shownCount` (how many the current view holds). The page no
 * longer holds every lead to find out whether there are any.
 */
import * as React from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import type { SmartView } from "@/components/features/leads/leads-smart-views";
import { LEAD_STAGES } from "@/lib/leads/stage-meta";

export interface LeadsStatusStatesProps {
  error: Error | null;
  refetch: () => unknown;
  isLoading: boolean;
  /** Every lead the caller can see; undefined until counted. */
  totalLeads: number | undefined;
  isDealsPage: boolean;
  isSales: boolean;
  /** Rows in the current view. */
  shownCount: number;
  smartView: SmartView;
  setAddOpen: (open: boolean) => void;
  setCsvImportOpen: (open: boolean) => void;
  setSmartView: (v: SmartView) => void;
}

export function LeadsStatusStates({
  error, refetch, isLoading, totalLeads, isDealsPage, isSales, shownCount, smartView, setAddOpen, setCsvImportOpen, setSmartView,
}: LeadsStatusStatesProps) {
  return (
    <>
      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load leads"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 flex-1 min-h-0">
          {LEAD_STAGES.map((s) => (
            <div key={s.id} className="bg-paper-2 border-2 border-dashed border-hairline rounded-lg p-2.5 min-h-[400px]">
              <div className="flex items-center gap-1.5 mb-3 px-1">
                <span className={cn("w-1.5 h-1.5 rounded-full", s.dot)} />
                <span className="text-xs font-semibold">{s.label}</span>
              </div>
              <div className="space-y-2">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty — copy + CTAs swap based on which page we're on. Import CSV
          stays a secondary action for owner/manager only (sales role has it
          hidden from the toolbar above; keeping it consistent here). */}
      {!isLoading && !error && totalLeads === 0 && (
        <EmptyState
          icon="target"
          title={isDealsPage ? "No deals yet" : "No leads yet"}
          body={
            isDealsPage
              ? "Qualified deals will appear here once a lead picks a plan. You can also add deals manually with a known seat count + value."
              : "Leads will appear here when customers fill the contact form, or you can add them manually."
          }
          action={
            <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
              {isDealsPage ? "Add your first deal" : "Add your first lead"}
            </Button>
          }
          secondary={!isSales ? <Button icon="download" onClick={() => setCsvImportOpen(true)}>Import CSV</Button> : undefined}
        />
      )}

      {/* Per-view empty — tenant HAS leads but the active smart view filter
          hides all of them. Purpose-specific message per view (research
          finding: generic "no results" loses users; targeted copy with a
          relevant action recovers them). */}
      {!isLoading && !error && (totalLeads ?? 0) > 0 && shownCount === 0 && smartView !== "all" && smartView !== "everything" && (
        <EmptyState
          icon={
            smartView === "today"   ? "clock" :
            smartView === "hot"     ? "zap" :
            smartView === "new"     ? "inbox" :
            smartView === "won-mtd" ? "trending_up" :
            smartView === "mine"    ? "user" : "target"
          }
          title={
            smartView === "today"   ? "No new leads today" :
            smartView === "hot"     ? "No hot leads right now" :
            smartView === "new"     ? "No new leads" :
            smartView === "won-mtd" ? "No wins this month yet" :
            smartView === "mine"    ? "You don't own any leads yet" :
            "No leads match this view"
          }
          body={
            smartView === "today"   ? "No new leads came in today. Use the Add Lead button to add one manually — new inbound leads will show up here." :
            smartView === "hot"     ? "No leads in Demo / Trial / Quote stage. Move qualified leads forward to surface hot opportunities." :
            smartView === "new"     ? "Inbox is clear. Switch to Hot or Won MTD to see what's moving." :
            smartView === "won-mtd" ? "Close your first deal this month — it'll show up here." :
            smartView === "mine"    ? "Leads assigned to you will appear here. Switch to All to see everyone's." :
            "Try a different view or clear filters."
          }
          action={
            <Button variant="primary" icon="eye" onClick={() => setSmartView("all")}>
              Show all leads
            </Button>
          }
        />
      )}
    </>
  );
}

export interface LeadsNoResultsProps {
  isLoading: boolean;
  error: Error | null;
  totalLeads: number | undefined;
  shownCount: number;
  smartView: SmartView;
  search: string;
  setSearch: (v: string) => void;
  setStageFilter: (v: Lead["stage"][]) => void;
  setPriorityFilter: (v: Array<"low" | "medium" | "high">) => void;
}

export function LeadsNoResults({
  isLoading, error, totalLeads, shownCount, smartView, search, setSearch, setStageFilter, setPriorityFilter,
}: LeadsNoResultsProps) {
  return (
    <>
      {/* No results from search OR tab cross-over hint.
          The split is BY STAGE, not by plan — see isRaw() above. /leads is stage
          `new` or `contact`; /deals is demo / trial / quote / won / lost. The old
          wording here ("no plan picked" / "plan set") was wrong and misled a reader
          into an inverted picture of where the pipeline actually sits.
          When the tenant has plenty of data but the current tab is empty, point the
          operator at the right place instead of a generic "no results". */}
      {!isLoading && !error && (totalLeads ?? 0) > 0 && shownCount === 0 && smartView === "all" && (
        <div className="mt-6">
          {search.trim() ? (
            <EmptyState
              icon="search"
              title="No leads match"
              body={`No results for "${search}". Try a different search term.`}
              action={<Button icon="x" onClick={() => setSearch("")}>Clear search</Button>}
              compact
            />
          ) : (
            <EmptyState
              icon="search"
              title="No leads match"
              body="No results match the active filters. Try clearing filters or stage selection."
              action={<Button icon="x" onClick={() => { setStageFilter([]); setPriorityFilter([]); }}>Clear filters</Button>}
              compact
            />
          )}
        </div>
      )}
    </>
  );
}
