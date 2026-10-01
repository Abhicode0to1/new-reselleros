"use client";
/**
 * "Poori history" — the deal page's one timeline, newest first, with filter chips and the
 * two things a rep adds from here: a note, and a follow-up. Events come from
 * lib/deals/timeline.ts; writing goes through the existing mutations (log_lead_activity,
 * the Call-log popup, AddTaskDialog), so nothing new can write to a lead.
 */
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, rupee } from "@/lib/utils";
import {
  DEAL_FILTERS, filterDealHistory, formatIstDateTime, formatIstDate,
  type DealFilter, type DealHistory, type DealEventTone,
} from "@/lib/deals/timeline";
import type { useLogLeadActivity } from "@/lib/queries/lead-activities";
import type { Lead } from "@/lib/supabase/database.types";

const TONE: Record<DealEventTone, string> = {
  ink: "text-ink-3", amber: "text-amber-ink", indigo: "text-indigo", emerald: "text-emerald", rose: "text-rose",
};

export interface DealHistoryFeedProps {
  lead: Lead;
  history: DealHistory;
  loading: boolean;
  /** Sources that could not be read — named, never silently missing. */
  failed: string[];
  logActivity: ReturnType<typeof useLogLeadActivity>;
  onCallLog: () => void;
  onAddFollowUp: () => void;
}

export function DealHistoryFeed({ lead, history, loading, failed, logActivity, onCallLog, onAddFollowUp }: DealHistoryFeedProps) {
  const [filter, setFilter] = React.useState<DealFilter>("all");
  const [note, setNote] = React.useState("");
  const rows = React.useMemo(() => filterDealHistory(history.events, filter), [history.events, filter]);

  const saveNote = () => {
    const text = note.trim();
    if (!text) return;
    logActivity.mutate(
      { leadId: lead.id, kind: "note", detail: text },
      { onSuccess: () => { setNote(""); toast.success("Note added"); } },
    );
  };

  return (
    <Card title="History" sub="Newest first">
      {/* Add to the history */}
      <div className="mb-4 space-y-2 rounded-lg border border-hairline bg-paper-2/40 p-3">
        <div className="flex items-start gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveNote(); }}
            rows={2}
            placeholder="Add a note…"
            aria-label={`Note on ${lead.company}`}
            className="min-w-0 flex-1 resize-y rounded-md border border-hairline bg-paper px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-amber focus:outline-none focus:ring-1 focus:ring-amber"
          />
          <Button size="sm" onClick={saveNote} disabled={!note.trim()} loading={logActivity.isPending}>Save</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon="mobile" onClick={onCallLog}>Log call</Button>
          <Button size="sm" icon="clock" onClick={onAddFollowUp}>Add follow-up</Button>
        </div>
      </div>

      {/* Filter chips */}
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]" role="tablist" aria-label="History filter">
        {DEAL_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
              filter === f.id ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline bg-paper text-ink-2 hover:bg-paper-2",
            )}
          >
            {f.label}
            <span className="tabular-nums text-ink-3">{history.counts[f.id]}</span>
          </button>
        ))}
      </div>

      {loading && history.events.length === 0 ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-md bg-paper-2 p-3 text-sm italic text-ink-3">
          {filter === "all" ? "No history yet." : "Nothing in this filter."}
        </p>
      ) : (
        <>
        {history.addedToAppOn && filter === "all" && (
          <p className="mb-3 rounded-md bg-paper-2 p-2.5 text-xs text-ink-2">
            Part of this deal happened before it was added to the app on {formatIstDate(history.addedToAppOn)}. Dates show when it happened.
          </p>
        )}
        <ol className="relative space-y-3">
          {rows.map((e) => (
            <li key={e.id} className="flex items-start gap-3">
              <div className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-hairline bg-paper-2", TONE[e.tone])}>
                <Icon name={e.icon} size={13} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  {e.href ? (
                    <Link href={e.href as never} className="min-w-0 text-sm font-medium text-ink hover:text-amber-ink hover:underline">
                      {e.title}
                    </Link>
                  ) : (
                    <span className="min-w-0 text-sm font-medium text-ink">{e.title}</span>
                  )}
                  {typeof e.amount === "number" && e.amount > 0 && (
                    <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-ink-2">{rupee(e.amount)}</span>
                  )}
                </div>
                {e.detail && (
                  <p className="line-clamp-3 break-words text-xs text-ink-2" title={e.detail}>{e.detail}</p>
                )}
                <p className="text-xs text-ink-3">
                  {e.who ? `${e.who} · ` : ""}{e.dateOnly ? formatIstDate(e.at) : formatIstDateTime(e.at)}
                  {e.addedOn ? ` · added to app ${formatIstDate(e.addedOn)}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ol>
        </>
      )}

      {(history.undated > 0 || failed.length > 0) && (
        <div className="mt-3 space-y-1 text-xs text-ink-3">
          {history.undated > 0 && (
            <p className="flex items-start gap-1"><Icon name="info" size={11} className="mt-0.5 shrink-0" />
              {history.undated} records have no date and are not shown.</p>
          )}
          {failed.length > 0 && (
            <p className="flex items-start gap-1"><Icon name="alert" size={11} className="mt-0.5 shrink-0" />
              Couldn't load (permission or network): {failed.join(", ")}.</p>
          )}
        </div>
      )}
    </Card>
  );
}
