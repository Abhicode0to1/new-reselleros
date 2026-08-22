/**
 * The tenant's own categorisation rules — the deterministic layer that decides what a
 * bank line IS before any model is asked. See docs/AI-CATEGORISATION-PLAN.md.
 *
 * RLS scopes the read to the tenant, so no filter is needed here (and adding one would be
 * the kind of belt that hides a missing brace).
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { CategoryRule } from "@/lib/banking/categorise";

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
