/**
 * User ids → display names, for showing WHO did something.
 *
 * ─── WHY A MAP AND NOT THE LIST add-lead-form ALREADY FETCHES ───────────────
 * That query feeds a dropdown, so it wants an ordered array of active users and it filters on
 * `is_active`. This one answers "whose id is this", which is a different question with a
 * different answer: a colleague who has LEFT still created the leads they created, and dropping
 * them would turn a real name into a blank on every lead they ever added. So this fetches
 * everyone, active or not, and keys by id.
 *
 * Not a refactor of the form's query for the same reason — they would fight over the filter.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "./useCurrentUser";

export interface UserName {
  id: string;
  /** `full_name`, or the email's local part when the name was never filled in. */
  label: string;
  /** True when this person is no longer active — the caller may want to say so. */
  inactive: boolean;
}

/**
 * Every user in the caller's tenant, keyed by id. RLS does the tenant scoping.
 *
 * Five-minute staleTime, matching the owner dropdown: a colleague's name changes about never,
 * and re-fetching it on every drawer open would be a request per click.
 */
export function useUserNames() {
  const { data: me } = useCurrentUser();

  return useQuery({
    queryKey: ["tenant", "user-names", me?.tenantId],
    enabled: Boolean(me?.tenantId),
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, UserName>> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name, email, is_active");
      if (error) throw error;

      const map = new Map<string, UserName>();
      for (const u of data ?? []) {
        /* A name, or the part of the address before the @ — never a bare uuid. An id shown to a
           person is worse than nothing: it looks like a bug and they cannot act on it. */
        const label = u.full_name?.trim() || u.email?.split("@")[0] || "a colleague";
        map.set(u.id, { id: u.id, label, inactive: u.is_active === false });
      }
      return map;
    },
  });
}
