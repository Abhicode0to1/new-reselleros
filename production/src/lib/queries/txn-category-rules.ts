/**
 * The tenant's own categorisation rules — the deterministic layer that decides what a
 * bank line IS before any model is asked. See docs/AI-CATEGORISATION-PLAN.md.
 *
 * RLS scopes the read to the tenant, so no filter is needed here (and adding one would be
 * the kind of belt that hides a missing brace).
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type { CategoryRule } from "@/lib/banking/categorise";
import type { TxnRuleDirection } from "@/lib/supabase/database.types";

export function useTxnCategoryRules() {
  return useQuery({
    queryKey: ["txn-category-rules"],
    queryFn: async (): Promise<CategoryRule[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("txn_category_rules")
        /* Ordered, even though categoriseByRules breaks every tie itself. Two independent
           reasons to sort: it makes the rows stable for anything that lists them, and it
           means a bug in the tie-break cannot express itself as "the same statement
           categorised differently on Tuesday". */
        .select("id, pattern, category, direction")
        .order("id", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CategoryRule[];
    },
    /* Rules change when an operator confirms a correction, not minute to minute. */
    staleTime: 60_000,
  });
}

/**
 * Remember a correction as a rule — Phase 4.
 *
 * ─── WHY THIS IS NOT AN UPSERT ──────────────────────────────────────────────
 * The unique index is on (tenant_id, upper(trim(pattern)), direction) — an EXPRESSION
 * index, so Supabase's `onConflict` cannot name it by column list. Insert-then-update on
 * 23505 is the honest way to express "one answer per narration per direction", and it is
 * also the right behaviour: a second rule for a pattern that already has one is a
 * correction of that rule, not a competitor to it. Two rules disagreeing about the same
 * narration would make the categoriser depend on its own tie-break, which is a defence,
 * not a place to route real decisions through.
 */
export function useCreateTxnCategoryRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      pattern: string;
      category: string;
      direction: TxnRuleDirection;
      /** The line that taught us, so the rule can be traced back to its example. */
      fromTxnId?: string | null;
    }) => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      if (!auth?.user) throw new Error("Not signed in");
      const { data: me, error: meErr } = await supabase
        .from("users").select("tenant_id").eq("id", auth.user.id).single();
      if (meErr) throw meErr;

      const pattern = input.pattern.trim();
      /* Guarded here as well as in the DB. The check constraint stops a blank pattern being
         stored; this stops a pointless round trip and gives a message an operator can act
         on instead of a Postgres error string. */
      if (!pattern) throw new Error("A rule needs some text to match on.");

      const row = {
        tenant_id: me!.tenant_id,
        pattern,
        category: input.category,
        direction: input.direction,
        created_from_txn_id: input.fromTxnId ?? null,
        created_by: auth.user.id,
      };

      const { error } = await supabase.from("txn_category_rules").insert(row);
      if (!error) return { updated: false };

      if (error.code !== "23505") throw error;

      /* Already exists for this pattern+direction → this is a correction of it. */
      const { error: upErr } = await supabase
        .from("txn_category_rules")
        .update({ category: input.category })
        .eq("tenant_id", me!.tenant_id)
        .eq("direction", input.direction)
        .ilike("pattern", pattern);
      if (upErr) throw upErr;
      return { updated: true };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["txn-category-rules"] });
      toast.success(r.updated ? "Rule updated." : "Saved — this will be categorised automatically next time.");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not save that rule");
    },
  });
}
