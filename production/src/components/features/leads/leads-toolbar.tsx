"use client";
/**
 * The Sales & Pipeline toolbar — whose leads, search, views, Kanban/List, Filter and More.
 * Moved verbatim out of (app)/leads/page.tsx (S35, 28 Sep 2026). All state stays in the
 * page; this only draws it.
 */
import * as React from "react";
import { toast } from "sonner";
import { TeamViewToggle } from "@/components/shared/team-view-toggle";
import { HIERARCHY_ENFORCED_IN_DATABASE } from "@/lib/team/enforcement";
import type { TeamViewMode } from "@/lib/team/visibility";
import type { useTeamTree } from "@/lib/queries/team-tree";
import { LeadsSmartViews, type SmartView } from "@/components/features/leads/leads-smart-views";
import { downloadCSV } from "@/lib/csv";
import { LEADS_CSV_HEADERS, leadsCsvRows } from "@/lib/export/crm-csv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import type { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import type { SalesFolder } from "@/lib/leads/folders";
import type { StageMeta } from "@/lib/leads/stage-meta";
import { istToday } from "@/lib/dates/ist";

type TeamMember = NonNullable<ReturnType<typeof useTeamTree>["data"]>[number];
type Priority = "low" | "medium" | "high";

export interface LeadsToolbarProps {
  leads: Lead[] | undefined;
  leadMeMember: TeamMember | null;
  leadTeam: TeamMember[];
  leadTeamMode: TeamViewMode;
  setLeadTeamMode: (m: TeamViewMode) => void;
  search: string;
  setSearch: (v: string) => void;
  leadsForTab: Lead[];
  everythingCount: number;
  currentUser: ReturnType<typeof useCurrentUser>["data"];
  duplicateCountForTab: number;
  junkCount: number;
  junkSuspectCount: number;
  smartView: SmartView;
  selectSmartView: (v: SmartView) => void;
  folderRows: { id: string; label: string; count: number; hint: string }[];
  folder: SalesFolder | "all";
  selectFolder: (f: SalesFolder | "all") => void;
  effectiveView: "kanban" | "list";
  setView: (v: "kanban" | "list") => void;
  activeFilterCount: number;
  filterStages: StageMeta[];
  stageFilter: Lead["stage"][];
  setStageFilter: React.Dispatch<React.SetStateAction<Lead["stage"][]>>;
  priorityFilter: Priority[];
  setPriorityFilter: React.Dispatch<React.SetStateAction<Priority[]>>;
  isSales: boolean;
  kpiOpen: boolean;
  setKpiOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setCsvImportOpen: (open: boolean) => void;
  setCampaignOpen: (open: boolean) => void;
  setGoogleImportOpen: (open: boolean) => void;
  setShareOpen: (open: boolean) => void;
}

export function LeadsToolbar({
  leads, leadMeMember, leadTeam, leadTeamMode, setLeadTeamMode, search, setSearch, leadsForTab,
  everythingCount, currentUser, duplicateCountForTab, junkCount, junkSuspectCount, smartView,
  selectSmartView, folderRows, folder, selectFolder, effectiveView, setView, activeFilterCount,
  filterStages, stageFilter, setStageFilter, priorityFilter, setPriorityFilter, isSales, kpiOpen,
  setKpiOpen, setCsvImportOpen, setCampaignOpen, setGoogleImportOpen, setShareOpen,
}: LeadsToolbarProps) {
  return (
    <>
    {/* Whose leads. Renders nothing for a rep with no reports — both halves would show
        the same rows, and a control that does nothing teaches people that controls do
        nothing. */}
    <TeamViewToggle
      className="shrink-0 mb-2"
      me={leadMeMember}
      all={leadTeam}
      mode={leadTeamMode}
      onChange={setLeadTeamMode}
      enforcedInDatabase={HIERARCHY_ENFORCED_IN_DATABASE}
      /* Counted BEFORE the toggle narrows anything — the note describes the pool being
         filtered, not the result. Unowned rows show in both halves, so without this the
         note claims "only records assigned to you" over rows assigned to nobody. */
      counts={{
        total: (leads ?? []).length,
        unassigned: (leads ?? []).filter((l) => !l.owner_id).length,
      }}
    />

    <div className="shrink-0 mb-3 flex items-center gap-2 flex-wrap">
      <div className="w-full sm:w-auto sm:flex-1 sm:min-w-[180px] sm:max-w-sm">
        <Input aria-label="Search leads & deals"
          prefix={<Icon name="search" size={14} />}
          placeholder="Search leads & deals…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-xs"
        />
      </div>

      <LeadsSmartViews
        leads={leadsForTab}
        everythingCount={everythingCount}
        currentUserId={currentUser?.userId}
        duplicateCount={duplicateCountForTab}
        junkCount={junkCount}
        junkSuspectCount={junkSuspectCount}
        active={smartView}
        onChange={selectSmartView}
        folders={folderRows}
        activeFolder={folder}
        onFolder={(id) => selectFolder(id as typeof folder)}
      />

      <div className="flex items-center gap-2 shrink-0">
        {/* View Switcher: Kanban vs List */}
        <div className="inline-flex rounded-md border border-hairline overflow-hidden">
          <button
            type="button"
            onClick={() => setView("kanban")}
            aria-pressed={effectiveView === "kanban"}
            className={cn(
              "px-2.5 py-1 text-xs font-medium inline-flex items-center gap-1 transition-colors cursor-pointer",
              effectiveView === "kanban" ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-paper-2"
            )}
            title="Kanban view — best for stage flow"
          >
            <Icon name="layout" size={13} /> Kanban
          </button>
          <button
            type="button"
            onClick={() => setView("list")}
            aria-pressed={effectiveView === "list"}
            className={cn(
              "px-2.5 py-1 text-xs font-medium inline-flex items-center gap-1 transition-colors border-l border-hairline cursor-pointer",
              effectiveView === "list" ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-paper-2"
            )}
            title="List view — best for scanning many leads"
          >
            <Icon name="more_h" size={13} /> List
          </button>
        </div>

        {/* Filter Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button icon="filter" size="sm">
              Filter
              {activeFilterCount > 0 && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-[16px] rounded-full bg-amber text-paper text-xs font-semibold px-1">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">Stage</DropdownMenuLabel>
            {filterStages.map((s) => (
              <DropdownMenuCheckboxItem
                key={s.id}
                checked={stageFilter.includes(s.id)}
                onCheckedChange={(checked) => {
                  setStageFilter((prev) =>
                    checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)
                  );
                }}
                className="text-sm"
              >
                <span className={cn("inline-block w-2 h-2 rounded-full mr-2", s.dot)} />
                {s.label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">Priority</DropdownMenuLabel>
            {(["high","medium","low"] as const).map((p) => (
              <DropdownMenuCheckboxItem
                key={p}
                checked={priorityFilter.includes(p)}
                onCheckedChange={(checked) => {
                  setPriorityFilter((prev) =>
                    checked ? [...prev, p] : prev.filter((x) => x !== p)
                  );
                }}
                className="text-sm capitalize"
              >
                <span className={cn("inline-block w-2 h-2 rounded-full mr-2",
                  p === "high"   && "bg-rose",
                  p === "medium" && "bg-amber",
                  p === "low"    && "bg-slate"
                )} />
                {p}
              </DropdownMenuCheckboxItem>
            ))}
            {activeFilterCount > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => { setStageFilter([]); setPriorityFilter([]); }}
                  className="text-sm text-rose"
                >
                  Clear all filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {!isSales && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="default" size="sm" icon="more_h">More</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* The numbers that used to sit in a permanent band above every lead: same
                  tiles, one click away instead of always on screen. */}
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setKpiOpen((o) => !o)}>
                <Icon name="bar_chart" size={14} /> {kpiOpen ? "Hide the numbers" : "Show the numbers"}
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setCsvImportOpen(true)}>
                <Icon name="download" size={14} className="text-ink-3" /> Import CSV
              </DropdownMenuItem>
              {/* Data-portability (audit B7): saari leads, jaisi darj hain. */}
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => { downloadCSV(`leads-${istToday()}.csv`, [...LEADS_CSV_HEADERS], leadsCsvRows(leads ?? [])); toast.success(`Exported ${(leads ?? []).length} leads to CSV`); }}>
                <Icon name="upload" size={14} className="text-ink-3" /> Export CSV
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setCampaignOpen(true)}>
                <Icon name="send" size={14} className="text-ink-3" /> Send campaign
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setGoogleImportOpen(true)}>
                <Icon name="globe" size={14} className="text-ink-3" /> Import from Google
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setShareOpen(true)}>
                <Icon name="link" size={14} className="text-ink-3" /> Share enquiry form
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
    </>
  );
}
