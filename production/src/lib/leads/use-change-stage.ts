/**
 * useChangeLeadStage — the single entry point for moving a lead between stages.
 *
 * A lead's stage can be changed from seven places (kanban drag, drawer button,
 * drawer dropdown, bulk bar, mobile card, list-row select, quick actions) spread
 * across three components, each of which used to call the mutation directly.
 * Asking "why lost?" at each site is precisely how this codebase ended up with
 * four conflicting definitions of "stale" — so the rule lives here instead.
 *
 * Behaviour:
 *   • moving to `lost` → prompt for a reason first; dismissing CANCELS the move
 *   • any other stage  → straight through
 *   • returns true when the stage actually changed, so callers know whether to
 *     show their success toast
 */
"use client";

import * as React from "react";
import { useUpdateLeadStage } from "@/lib/queries/leads";
import { useLossReason } from "@/components/providers/loss-reason-provider";
import type { Lead } from "@/lib/supabase/database.types";

type StageTarget = Pick<Lead, "id" | "stage" | "company">;

export function useChangeLeadStage() {
  const updateStage = useUpdateLeadStage();
  const askLossReason = useLossReason();

  const changeStage = React.useCallback(
    async (lead: StageTarget, stage: Lead["stage"]): Promise<boolean> => {
      if (lead.stage === stage) return false;

      if (stage === "lost") {
        const reason = await askLossReason(lead.company);
        // Dismissed. A loss with no reason is the exact thing this feature
        // exists to prevent, so we leave the lead where it is rather than
        // recording an unexplained one.
        if (!reason) return false;
        await updateStage.mutateAsync({
          id: lead.id, stage, lostReason: reason.code, lostNote: reason.note,
        });
        return true;
      }

      await updateStage.mutateAsync({ id: lead.id, stage });
      return true;
    },
    [askLossReason, updateStage],
  );

  /**
   * Bulk version. Asks for the reason ONCE and applies it to every selected
   * lead — prompting twenty times for a twenty-row selection would guarantee
   * the rep just stops using the bulk bar.
   *
   * Returns the number of leads actually moved (0 if the prompt was dismissed).
   */
  const changeStageBulk = React.useCallback(
    async (leads: readonly StageTarget[], stage: Lead["stage"]): Promise<number> => {
      const targets = leads.filter((l) => l.stage !== stage);
      if (targets.length === 0) return 0;

      let lostReason: string | null = null;
      let lostNote: string | null = null;
      if (stage === "lost") {
        const reason = await askLossReason(
          targets.length === 1 ? targets[0].company : `${targets.length} deals`,
        );
        if (!reason) return 0;
        lostReason = reason.code;
        lostNote = reason.note;
      }

      await Promise.all(
        targets.map((l) => updateStage.mutateAsync({ id: l.id, stage, lostReason, lostNote })),
      );
      return targets.length;
    },
    [askLossReason, updateStage],
  );

  return { changeStage, changeStageBulk, isPending: updateStage.isPending };
}
