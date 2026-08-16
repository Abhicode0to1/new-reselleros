"use client";

/**
 * Seat requests raised by customers.
 *
 * Read-only from the app's side. Deciding one goes through
 * /api/seat-requests/[id]/decide, because approving ADDS SEATS and raises a quote —
 * that runs server-side with the service role, and putting the write here would give
 * the browser a path to change a subscription without the guards.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { SeatRequest } from "@/lib/supabase/database.types";

export function useSeatRequests(opts?: { pendingOnly?: boolean }) {
  return useQuery({
    queryKey: ["seat-requests", opts?.pendingOnly ?? false],
    queryFn: async (): Promise<SeatRequest[]> => {
      const supabase = createClient();
      let q = supabase.from("seat_requests").select("*").order("created_at", { ascending: true });
      if (opts?.pendingOnly) q = q.eq("status", "pending");
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    /* Short, because this is a queue somebody is working through and a decided row
       should stop showing up promptly. */
    staleTime: 30_000,
  });
}
