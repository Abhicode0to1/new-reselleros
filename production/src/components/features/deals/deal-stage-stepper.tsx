"use client";
/**
 * Deal page stage stepper — Quote → Demo → Trial → Won, with Lost to the side.
 *
 * Same rules as the board, not a second copy of them: every click is judged by
 * checkBoardMove (lib/leads/deal-rules.ts) and written through changeStage
 * (lib/leads/use-change-stage.ts), which asks for a loss reason on Lost. A refused move
 * says what is missing (§24) and nothing is written.
 */
import * as React from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { checkBoardMove } from "@/lib/leads/deal-rules";
import { STAGE_LABEL } from "@/lib/leads/stage-meta";
import { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import { useConfirm } from "@/components/providers/confirm-provider";
import type { Lead } from "@/lib/supabase/database.types";

const STEPS: Lead["stage"][] = ["quote", "demo", "trial", "won"];

export function DealStageStepper({ lead }: { lead: Pick<Lead, "id" | "stage" | "company" | "value" | "expected_close_date"> }) {
  const { changeStage, isPending } = useChangeLeadStage();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const currentIdx = STEPS.indexOf(lead.stage);
  const name = lead.company?.trim() || "Deal";

  const move = async (to: Lead["stage"]) => {
    if (to === lead.stage || isPending) return;
    const verdict = checkBoardMove(lead, to);
    if (!verdict.ok) {
      toast.error(verdict.title, { description: verdict.description });
      return;
    }
    if (to !== "lost") {
      const ok = await confirm({
        title: `${name}: ${STAGE_LABEL[lead.stage]} → ${STAGE_LABEL[to]}?`,
        body: "Stage badalne se board, forecast aur report sab isi hisaab se chalenge.",
        confirmLabel: "Haan, badlo",
      });
      if (!ok) return;
    }
    try {
      const moved = await changeStage(lead, to);
      if (moved) {
        toast.success(`${name} → ${STAGE_LABEL[to]}`);
        void qc.invalidateQueries({ queryKey: ["deal-history"] });
      }
    } catch (e) {
      toast.error("Stage nahi badla", { description: (e as Error).message });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ol className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Deal stage">
        {STEPS.map((s, i) => {
          const done = currentIdx >= 0 && i < currentIdx;
          const current = s === lead.stage;
          return (
            <li key={s} className="flex shrink-0 items-center gap-1">
              {i > 0 && <span aria-hidden className={cn("hidden h-px w-5 sm:block", done || current ? "bg-amber" : "bg-hairline-strong")} />}
              <button
                type="button"
                onClick={() => void move(s)}
                disabled={current || isPending}
                aria-current={current ? "step" : undefined}
                title={current ? "Abhi yahi stage hai" : `${STAGE_LABEL[s]} par le jao`}
                className={cn(
                  "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                  current && s === "won" && "border-emerald bg-emerald-soft text-emerald cursor-default",
                  current && s !== "won" && "border-amber bg-amber-soft text-amber-ink cursor-default",
                  !current && done && "border-amber/40 bg-paper text-ink-2 hover:bg-paper-2",
                  !current && !done && "border-hairline bg-paper text-ink-3 hover:bg-paper-2 hover:text-ink",
                )}
              >
                {done ? <Icon name="check" size={12} /> : <span aria-hidden className="tabular-nums">{i + 1}</span>}
                {STAGE_LABEL[s]}
              </button>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        onClick={() => void move("lost")}
        disabled={lead.stage === "lost" || isPending}
        className={cn(
          "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
          lead.stage === "lost"
            ? "border-rose bg-rose-soft text-rose-ink cursor-default"
            : "border-hairline bg-paper text-ink-3 hover:border-rose/50 hover:text-rose",
        )}
      >
        <Icon name="x_circle" size={12} />
        {lead.stage === "lost" ? "Lost" : "Lost mark karo"}
      </button>
    </div>
  );
}
