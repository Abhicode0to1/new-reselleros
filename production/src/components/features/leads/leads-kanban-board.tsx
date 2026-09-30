"use client";
/**
 * The Sales & Pipeline Kanban board — moved verbatim out of (app)/leads/page.tsx (S35,
 * 28 Sep 2026), with the drag state it alone uses. The page decides WHEN it renders and
 * WHICH leads it holds (`boardCut` in lib/leads/list-selectors.ts).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LeadCard } from "@/components/features/leads/lead-card";
import { Icon } from "@/components/ui/icon";
import { rupee, cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import type { LeadListRow } from "@/lib/leads/list-page";
import type { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import { DEAL_STAGES, LEAD_STAGES } from "@/lib/leads/stage-meta";
import { BOARD_COLUMN_CAP } from "@/lib/queries/leads";

export interface LeadsKanbanBoardProps {
  boardLeads: LeadListRow[];
  /** Each column's server total (useLeadsBoard) — the board holds the newest BOARD_COLUMN_CAP. */
  columnTotals?: Partial<Record<Lead["stage"], number>>;
  changeStage: ReturnType<typeof useChangeLeadStage>["changeStage"];
  setSelected: (l: LeadListRow) => void;
  setAddOpen: (open: boolean) => void;
}

export function LeadsKanbanBoard({ boardLeads, columnTotals, changeStage, setSelected, setAddOpen }: LeadsKanbanBoardProps) {
  const router = useRouter();
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overStage, setOverStage] = React.useState<Lead["stage"] | null>(null);

  // Drag handlers
  const handleDrop = async (toStage: Lead["stage"]) => {
    if (dragId) {
      const lead = boardLeads.find((l) => l.id === dragId);
      /* A won deal cannot be dragged back out.
         The inline stage dropdown already refuses this (lib/leads/stage-options.ts) because
         un-winning means money already recorded — a payment, an invoice, a subscription.
         Leaving the board as a second, unguarded route to the same write would make the
         lock decorative: the rep would simply drag instead.
         §24 — say what happened, why, and what to do instead, never a bare "not allowed". */
      if (lead && lead.stage === "won" && toStage !== "won") {
        toast.error(`${lead.company} is already won`, {
          description:
            "Money is recorded against it — a payment, an invoice and a subscription. " +
            "Reopening it here would leave those behind. Raise a credit note on the invoice instead.",
          action: { label: "Open invoices", onClick: () => router.push("/invoices") },
        });
        setDragId(null);
        setOverStage(null);
        return;
      }
      if (lead && lead.stage !== toStage) {
        // Dropping onto Lost opens the reason prompt first; if it's dismissed
        // changeStage returns false and the card stays where it was.
        const moved = await changeStage(lead, toStage);
        if (moved) {
          const stageLabel = LEAD_STAGES.find((s) => s.id === toStage)?.label;
          toast.success(`${lead.company} → ${stageLabel}`);
        }
      }
    }
    setDragId(null);
    setOverStage(null);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Auto-fit Kanban grid stretching 100% of remaining viewport height.

          `lg:grid-cols-none` is load-bearing — without it the first two columns
          collapse to ZERO WIDTH and the board hides most of the pipeline.

          Measured on 22 Aug 2026 at a 1051px viewport, before the reset was added:
              grid-template-columns: 0px 0px 220px 220px 220px 220px
          New (9 leads) and Contacted (26) were the 0px ones — 35 of 37 deals with no
          width to render in, while the footer read "37 total deals visible". Reported
          from this screen as "canban view sahi show nahi ho raha hai".

          The mechanism: `sm:grid-cols-2` sets an EXPLICIT two-column template, and
          nothing used to switch it off further up. With `grid-flow-col`, items 1-2 land
          in those explicit columns and 3-6 create implicit ones —
          `auto-cols-[minmax(220px,1fr)]` only ever applies to the IMPLICIT columns. The
          four implicit columns took 880px of a 779px container, leaving the explicit
          pair's `1fr` to resolve to 0. Resetting the template makes all six implicit, so
          every column gets the 220px floor and the row scrolls as intended (1380px). */}
      <div className="flex-1 min-h-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-none lg:grid-flow-col lg:auto-cols-[minmax(220px,1fr)] lg:grid-rows-1 gap-3 overflow-x-auto overflow-y-hidden pb-1">
        {DEAL_STAGES.map((stage) => {
          const stageLeads = boardLeads.filter((l) => l.stage === stage.id);
          const stageValue = stageLeads.reduce((s, l) => s + (l.value ?? 0), 0);
          const isOver = overStage === stage.id;

          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault();
                setOverStage(stage.id);
              }}
              onDragLeave={() => setOverStage(null)}
              onDrop={() => handleDrop(stage.id)}
              className={cn(
                "rounded-xl p-2.5 flex flex-col min-h-0 h-full overflow-hidden transition-colors bg-paper-2/70 border-2",
                isOver ? "border-solid border-amber" : "border-dashed border-hairline"
              )}
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-1 pb-2 mb-2 border-b border-hairline shrink-0">
                <div className="flex items-center gap-1.5">
                  <span className={cn("w-2 h-2 rounded-full", stage.dot)} />
                  <span className="text-xs font-bold text-ink">{stage.label}</span>
                  <span className="text-3xs px-1.5 py-0.5 rounded-full bg-paper text-ink-2 font-mono tabular-nums border border-hairline">
                    {stageLeads.length}
                  </span>
                </div>
                <span className="font-serif text-xs font-bold text-amber-ink tabular-nums">
                  {stageValue > 0 ? rupee(stageValue, { compact: true }) : ""}
                </span>
              </div>

              {/* Cards container — per-column independent vertical scroll */}
              <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5 custom-scrollbar">
                {stageLeads.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    isDragging={dragId === lead.id}
                    onDragStart={setDragId}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverStage(null);
                    }}
                    onClick={(l) => setSelected(l)}
                  />
                ))}

                {stageLeads.length === 0 && (
                  <div className="h-20 flex items-center justify-center border border-dashed border-hairline/60 rounded-md text-xs text-ink-3">
                    No deals in {stage.label.toLowerCase()}
                  </div>
                )}

                {/* WC-scale: a column holds its newest BOARD_COLUMN_CAP cards. Said out loud,
                    so a capped column is not read as the whole stage. */}
                {(columnTotals?.[stage.id] ?? 0) > BOARD_COLUMN_CAP && (
                  <p className="px-1 py-1.5 text-3xs text-ink-3 tabular-nums">
                    Newest {BOARD_COLUMN_CAP.toLocaleString("en-IN")} of {(columnTotals?.[stage.id] ?? 0).toLocaleString("en-IN")} · List view shows all
                  </p>
                )}
              </div>

              {/* Quick Add Deal in column */}
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="mt-2 shrink-0 border border-dashed border-hairline hover:border-hairline-strong rounded-md py-1.5 text-xs font-medium text-ink-3 hover:text-ink flex items-center justify-center gap-1 transition-colors cursor-pointer bg-paper/50 hover:bg-paper"
              >
                <Icon name="plus" size={12} /> Add deal
              </button>
            </div>
          );
        })}
      </div>

      {/* Footer status bar */}
      <div className="shrink-0 flex items-center justify-between text-xs text-ink-3 pt-1.5 px-1">
        <span className="flex items-center gap-1">
          <Icon name="info" size={12} /> Drag cards across columns to update pipeline stage instantly
        </span>
        {/* `boardLeads`, not `filtered`. This footer counted the LIST's set while the
            columns render the BOARD's, and the moment the Won column started holding
            cards the two disagreed on the same screen — 11 cards above "9 visible".
            "Visible" must mean what is visible. */}
        <span className="font-mono">{boardLeads.length} total deal{boardLeads.length === 1 ? "" : "s"} visible</span>
      </div>
    </div>
  );
}
