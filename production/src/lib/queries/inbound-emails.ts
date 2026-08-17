/**
 * Inbound emails — the Enquiries Inbox data layer.
 *
 * Fetches tenant-scoped inbound emails via server endpoint /api/inbound-emails
 * and handles atomic lead conversion.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { InboundEmailRow } from "@/lib/supabase/database.types";

export function useInboundEmails() {
  return useQuery({
    queryKey: ["inbound-emails"],
    queryFn: async (): Promise<InboundEmailRow[]> => {
      const res = await fetch("/api/inbound-emails");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not fetch inbound emails");
      }
      return res.json();
    },
  });
}

/**
 * Read, star, snooze, archive.
 *
 * ─── OPTIMISTIC, BECAUSE THESE ARE THE CLICKS A REP MAKES ALL DAY ───────────
 * Starring and archiving happen dozens of times an hour. A round-trip before the row
 * moves makes the inbox feel broken, and a rep who is not sure the click registered
 * clicks again. onMutate moves it immediately; onError puts it back and says so, so
 * a failed archive can never look like a successful one.
 */
export function useSetInboundState() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id: string;
      read?: boolean;
      starred?: boolean;
      /** ISO instant, or null to wake it now. */
      snoozeUntil?: string | null;
      archived?: boolean;
    }) => {
      const { id, ...body } = input;
      const res = await fetch(`/api/inbound-emails/${id}/state`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not update this email");
      }
      return res.json();
    },

    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ["inbound-emails"] });
      const previous = qc.getQueryData<InboundEmailRow[]>(["inbound-emails"]);
      qc.setQueryData<InboundEmailRow[]>(["inbound-emails"], (rows) =>
        (rows ?? []).map((r) => {
          if (r.id !== input.id) return r;
          const now = new Date().toISOString();
          return {
            ...r,
            /* Mirrors the server: a first-open stamp never overwrites an earlier one. */
            read_at: input.read === true ? (r.read_at ?? now)
                   : input.read === false ? null
                   : r.read_at,
            starred:       input.starred ?? r.starred,
            snoozed_until: input.snoozeUntil !== undefined ? input.snoozeUntil : r.snoozed_until,
            archived_at:   input.archived === undefined ? r.archived_at
                         : input.archived ? now : null,
          };
        }),
      );
      return { previous };
    },

    onError: (err, _input, ctx) => {
      if (ctx?.previous) qc.setQueryData(["inbound-emails"], ctx.previous);
      toast.error((err as Error).message, {
        description: "Nothing was changed — the email is back where it was.",
      });
    },

    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["inbound-emails"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
    },
  });
}

export function useConvertInboundToLead() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const res = await fetch(`/api/inbound-emails/${id}/convert`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not convert email to lead");
      }
      const data = await res.json();
      return data.leadId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbound-emails"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Lead created from email");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
