/**
 * useLeadOutcome — performs the effect that `applyOutcome` describes.
 *
 * The split is deliberate: outcomes.ts holds the RULES (pure, tested, no React), this
 * holds the plumbing (mutations, toast, navigation). Every one of the seven places a
 * lead's stage used to be changed from had its own copy of the rules, which is how this
 * codebase ended up with four definitions of "stale" — noted in use-change-stage.ts's
 * own header. One entry point, one behaviour.
 *
 * Responsiveness: both underlying mutations write optimistically with rollback
 * (`useUpdateLead` and `useSetLeadJunk` in queries/leads.ts), so the row reflects the
 * tap on the next render rather than after the round-trip. The activity row is logged
 * fire-and-forget — a failed log must never undo a follow-up date the rep can see has
 * moved.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useUpdateLead, useSetLeadJunk } from "@/lib/queries/leads";
import { useLogLeadActivity } from "@/lib/queries/lead-activities";
import { applyOutcome, type LeadOutcome } from "./outcomes";
import type { Lead } from "@/lib/supabase/database.types";

type OutcomeTarget = Pick<
  Lead, "id" | "company" | "contact_phone" | "follow_up_date" | "plan" | "seats" | "value"
>;

export function useLeadOutcome() {
  const updateLead = useUpdateLead({ quiet: true });   // this hook owns the toast
  const setJunk    = useSetLeadJunk();
  const logActivity = useLogLeadActivity();
  const router = useRouter();

  return React.useCallback(
    async (outcome: LeadOutcome, lead: OutcomeTarget): Promise<void> => {
      const eff = applyOutcome(outcome, lead);

      if (eff.navigate === "quote") {
        /* Carries the lead's context into the builder. The stage stays where it is
           until a quote row actually exists — see outcomes.ts. */
        const q = new URLSearchParams({ leadId: lead.id, company: lead.company });
        if (lead.plan)  q.set("plan", lead.plan);
        if (lead.seats) q.set("seats", String(lead.seats));
        router.push(`/quotes/new?${q.toString()}`);
        return;
      }

      const previousFollowUp = lead.follow_up_date ?? null;

      try {
        if (eff.patch && "is_junk" in eff.patch) {
          await setJunk.mutateAsync({ ids: [lead.id], isJunk: true });
          // setJunk toasts on its own; don't double up.
        } else if (eff.patch) {
          await updateLead.mutateAsync({ id: lead.id, patch: eff.patch });
          toast.success(eff.toast, eff.undoable ? {
            action: {
              label: "Undo",
              /* Restores the exact previous value, including null. "Undo" that reset
                 the field to today would be a second change wearing the label of a
                 reversal. */
              onClick: () => {
                updateLead.mutate({ id: lead.id, patch: { follow_up_date: previousFollowUp } });
              },
            },
          } : undefined);
        }
      } catch {
        // Both mutations roll their optimistic write back and toast the error.
        return;
      }

      if (eff.activity) {
        // Fire-and-forget: a failed log must not undo a visible follow-up change.
        logActivity.mutate({ leadId: lead.id, kind: eff.activity.kind, detail: eff.activity.detail });
      }
    },
    [updateLead, setJunk, logActivity, router],
  );
}
