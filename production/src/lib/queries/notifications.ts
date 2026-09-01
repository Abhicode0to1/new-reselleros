/**
 * In-app notifications ke hooks (audit B4).
 *
 * Realtime nahi, POLLING (60s) — is codebase me supabase.channel ka ek bhi
 * precedent nahi hai, aur khabar ke liye minute-bhar ki deri theek hai;
 * untested websocket-raasta pehli baar yahan kholna khabar se mehnga sauda
 * hota. Read-state DB me hai (row ka read_at) — localStorage wala purana
 * panel doosre device par sab wapas unread kar deta tha.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { NotificationRow } from "@/lib/supabase/database.types";

const KEY = ["notifications"] as const;

export function useNotifications(limit = 40) {
  return useQuery({
    queryKey: [...KEY, limit],
    queryFn: async (): Promise<NotificationRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .is("read_at", null);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      // RLS apni rows par hi update hone deti hai — filter sirf "abhi unread".
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .is("read_at", null);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
