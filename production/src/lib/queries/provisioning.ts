"use client";

/**
 * Provisioning tasks for a quote.
 *
 * The trigger raises ONE unresolved row when a quote is first paid; `useProvisioning`
 * reads it and `planProvisioning` decides what it means. Expanding it into per-line
 * tasks is a write, and it happens on demand rather than automatically — a rep opening
 * a quote is the moment somebody is actually about to do the work, and expanding
 * eagerly on every read would spawn rows nobody asked for.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import type { ProvisioningTask } from "@/lib/supabase/database.types";

export function useProvisioning(quoteId: string | undefined) {
  return useQuery({
    queryKey: ["provisioning", quoteId],
    enabled: Boolean(quoteId),
    queryFn: async (): Promise<ProvisioningTask[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("provisioning_tasks")
        .select("*")
        .eq("quote_id", quoteId!)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Mark one task done / failed / not required, with who and when. */
export function useUpdateProvisioning() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      status: "pending" | "in_progress" | "done" | "failed" | "not_required";
      userId?: string;
      errorMessage?: string | null;
    }) => {
      const supabase = createClient();
      const settled = input.status === "done" || input.status === "not_required";
      const { data, error } = await supabase
        .from("provisioning_tasks")
        .update({
          status: input.status,
          /* Stamped only when the task actually finishes — a "completed_at" on an
             in-progress row would make an audit read as work that was done. */
          completed_at: settled ? new Date().toISOString() : null,
          completed_by: settled ? (input.userId ?? null) : null,
          error_message: input.status === "failed" ? (input.errorMessage ?? null) : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["provisioning"] });
      void v;
    },
    onError: (err) => toastError(err),
  });
}

/**
 * Replace the single unresolved row with one task per line that needs setting up.
 *
 * Called once, when a rep first opens a paid quote's provisioning list. Idempotent by
 * construction: it only runs when exactly one unresolved row (no vendor) exists.
 */
export function useExpandProvisioning() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      placeholderId: string;
      tenantId: string;
      quoteId: string;
      items: Array<{ vendor: string; plan: string; seats: number; domain: string | null; mode: string }>;
    }) => {
      const supabase = createClient();

      if (input.items.length === 0) {
        /* Nothing to create. Recorded as not_required rather than deleted, so the
           quote's history says "we looked and there was nothing" instead of looking
           like provisioning was never considered. */
        const { error } = await supabase
          .from("provisioning_tasks")
          .update({ status: "not_required", updated_at: new Date().toISOString() })
          .eq("id", input.placeholderId);
        if (error) throw error;
        return;
      }

      const { error: insErr } = await supabase.from("provisioning_tasks").insert(
        input.items.map((i) => ({
          tenant_id: input.tenantId,
          quote_id: input.quoteId,
          vendor: i.vendor,
          plan: i.plan,
          seats: i.seats,
          domain: i.domain,
          mode: i.mode,
          status: "pending",
        })),
      );
      if (insErr) throw insErr;

      /* The placeholder goes only AFTER the real rows land. Deleting first would, on a
         failed insert, leave a paid quote with no provisioning obligation at all —
         losing the work silently is worse than a duplicate row. */
      const { error: delErr } = await supabase
        .from("provisioning_tasks").delete().eq("id", input.placeholderId);
      if (delErr) throw delErr;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["provisioning"] }),
    onError: (err) => toastError(err),
  });
}
