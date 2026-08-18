/**
 * The reporting tree, read in a way that survives the column not existing yet.
 *
 * ─── WHY `select("*")` AND NOT `select("id, manager_id, role")` ──────────────
 * `users.manager_id` ships in a migration that has NOT been applied to production. Naming
 * it in a select would make PostgREST reject the whole request, and this codebase has
 * already lost two days to exactly that shape of failure: one added column produced
 * PGRST201 on the identity query, the hook returned null, and the sidebar read
 * "Loading… / Workspace" for ever. It looked like a slow network, not a broken query.
 *
 * So the column is read if it is there and treated as absent if it is not. Before the
 * migration every user has `managerId: null`, so nobody has subordinates, every non-owner
 * gets the `own` scope and the Team toggle simply does not render. The feature is invisible
 * rather than broken — which is the only acceptable way for an unshipped migration to show
 * up on screen.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { TeamMember } from "@/lib/team/visibility";

/** The shape we read out of a row, without asserting the column exists. */
interface MaybeHierarchyRow {
  id?: unknown;
  role?: unknown;
  manager_id?: unknown;
  is_active?: unknown;
}

function toMember(row: MaybeHierarchyRow): TeamMember | null {
  if (typeof row.id !== "string") return null;
  return {
    id: row.id,
    role: typeof row.role === "string" ? row.role : "sales",
    /* Absent column, SQL NULL and a non-string all mean the same thing here: no manager. */
    managerId: typeof row.manager_id === "string" ? row.manager_id : null,
  };
}

export function useTeamTree() {
  return useQuery({
    queryKey: ["team-tree"],
    /* The tree changes when somebody is hired or moved, not between page views. */
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<TeamMember[]> => {
      const supabase = createClient();
      /* RLS scopes this to the caller's tenant, so no explicit tenant filter is needed —
         and adding one from the client would be the weaker of the two guards anyway. */
      const { data, error } = await supabase.from("users").select("*").eq("is_active", true);
      if (error) throw error;
      return (data as MaybeHierarchyRow[] ?? []).map(toMember).filter((m): m is TeamMember => m !== null);
    },
  });
}
