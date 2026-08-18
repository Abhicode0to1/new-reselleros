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

/**
 * What has already been sent in answer to one enquiry.
 *
 * Read from email_log through the route, never from a flag on the row — see
 * lib/inbound/replied.ts for why. Disabled until an enquiry is selected, so opening the
 * page does not fire a request per email in the list.
 */
export function useEnquiryReplies(enquiryId: string | null) {
  return useQuery({
    queryKey: ["enquiry-replies", enquiryId],
    enabled: enquiryId != null,
    queryFn: async (): Promise<{ sentAt: string; status: string; subject: string | null }[]> => {
      const res = await fetch(`/api/inbound-emails/${enquiryId}/reply`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not check what was already sent");
      }
      const json = await res.json();
      return json.replies ?? [];
    },
  });
}

/**
 * Send a reply to an enquiry.
 *
 * ─── NOT OPTIMISTIC, UNLIKE STAR AND ARCHIVE ────────────────────────────────
 * Those move a row and are undoable. This puts an email in a stranger's inbox and cannot
 * be recalled, so the button stays in its loading state until the server says the send
 * happened. A composer that clears itself on click would, on a failed send, leave a rep
 * looking at an empty box believing the customer had been answered.
 */
export function useSendEnquiryReply() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; subject: string; body: string }) => {
      const { id, ...body } = input;

      let res: Response;
      try {
        res = await fetch(`/api/inbound-emails/${id}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        /* ─── NO ANSWER IS NOT THE SAME AS "IT FAILED" ─────────────────────────
           This happened on 18 Aug 2026 and is the reason the branch exists. Pardeep
           pressed Send, the server sent the mail through Gmail (email_log 04:15:18 UTC,
           status sent, id 1a01314af035739c) — and the connection dropped before the
           reply came back. The screen said "The reply did not send… your text is still
           in the box", which is an invitation to send a second copy of an email the
           customer already had.

           A thrown fetch means the outcome is UNKNOWN. Saying so is the only honest
           answer, and it is the opposite instruction: go and look, do not resend. */
        throw new UnknownSendOutcome(e instanceof Error ? e.message : "connection lost");
      }

      const json = await res.json().catch(() => ({}));
      /* The server answered — this IS a known failure, and nothing was sent: the route
         returns 502 only after sendEmail reported failure. */
      if (!res.ok) throw new Error(json.error || "Could not send this reply");
      return json as { ok: true; stub: boolean; provider: string };
    },
    onSuccess: (result, input) => {
      qc.invalidateQueries({ queryKey: ["enquiry-replies", input.id] });
      if (result.stub) {
        /* §24 — the honest version. No provider is configured, so nothing left. Saying
           "Sent" here is the exact lie this codebase keeps hunting. */
        toast.warning("Nothing was actually sent — no email provider is connected.", {
          description: "The reply was recorded but no mail left. Connect Gmail or Resend in Settings, then send it again.",
        });
      } else {
        toast.success("Reply sent.");
      }
    },
    onError: (e: Error, input) => {
      if (e instanceof UnknownSendOutcome) {
        /* Deliberately NOT an error toast and NOT "did not send". The mail may well be
           in the customer's inbox. §24 — what happened, why, and the next step, which
           here is CHECK rather than retry. */
        qc.invalidateQueries({ queryKey: ["enquiry-replies", input.id] });
        toast.warning("The connection dropped — we do not know if this went out.", {
          description: "It may already be with the customer. Reload this enquiry: if it says you have replied, it was sent. Do not send again until you have checked.",
        });
        return;
      }
      toast.error("The reply did not send.", {
        description: `${e.message} Your text is still in the box — nothing was lost.`,
      });
    },
  });
}

/**
 * The request never got an answer, so the send may or may not have happened.
 *
 * A distinct class rather than a message string because the two cases need opposite
 * advice — "try again" for a refusal the server stated, "go and check" for a silence —
 * and a string comparison is how that distinction quietly rots.
 */
export class UnknownSendOutcome extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "UnknownSendOutcome";
  }
}

/**
 * Which address this workspace's mail actually leaves from.
 *
 * Cached for the session — it changes only when somebody reconnects an account in
 * Settings, and asking on every render would be a request per enquiry click.
 */
export function useEmailSender() {
  return useQuery({
    queryKey: ["email-sender"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ provider: string | null; address: string | null }> => {
      const res = await fetch("/api/settings/email-sender");
      if (!res.ok) return { provider: null, address: null };
      return res.json();
    },
  });
}
