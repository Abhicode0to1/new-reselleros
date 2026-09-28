/**
 * WhatsApp — TanStack Query hooks for the /whatsapp Inbox page.
 *
 * Two views:
 *   - useWhatsAppConversations() — list of contacts with last message
 *   - useWhatsAppThread(phone)   — full message log for one contact
 *
 * Mutations:
 *   - useSendWhatsApp() — calls /api/whatsapp/send
 */

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { WhatsAppMessageRow } from "@/lib/supabase/database.types";

/** One contact's last message + count of inbound messages we haven't
 *  marked read yet (treat anything inbound as unread for first cut). */
export interface WhatsAppConversation {
  contact_phone:    string;
  last_message:     WhatsAppMessageRow;
  last_inbound_at:  string | null;
  unread_count:     number;
  message_count:    number;
}

export function useWhatsAppConversations() {
  return useQuery({
    queryKey: ["whatsapp", "conversations"],
    queryFn: async (): Promise<WhatsAppConversation[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("whatsapp_messages")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;

      // Group by contact, keep the newest as "last_message".
      const byPhone = new Map<string, WhatsAppConversation>();
      for (const m of (data ?? []) as WhatsAppMessageRow[]) {
        const c = byPhone.get(m.contact_phone);
        if (!c) {
          byPhone.set(m.contact_phone, {
            contact_phone:   m.contact_phone,
            last_message:    m,
            last_inbound_at: m.direction === "inbound" ? m.created_at : null,
            unread_count:    m.direction === "inbound" ? 1 : 0,
            message_count:   1,
          });
        } else {
          c.message_count++;
          if (m.direction === "inbound") {
            c.unread_count++;
            if (!c.last_inbound_at || m.created_at > c.last_inbound_at) {
              c.last_inbound_at = m.created_at;
            }
          }
        }
      }
      // Sort by recency of any message — last_message is already the newest per contact
      return [...byPhone.values()].sort(
        (a, b) => b.last_message.created_at.localeCompare(a.last_message.created_at),
      );
    },
    // Realtime poll — 15s feels live enough without hammering Supabase
    refetchInterval: 15_000,
  });
}

/** How many of the latest messages one thread poll loads. */
export const WHATSAPP_THREAD_MAX = 200;

export function useWhatsAppThread(contactPhone: string | null) {
  return useQuery({
    queryKey: ["whatsapp", "thread", contactPhone ?? "none"],
    enabled:  Boolean(contactPhone),
    queryFn: async (): Promise<WhatsAppMessageRow[]> => {
      const supabase = createClient();
      /* S16: bounded. This polls every 10s and used to fetch the WHOLE history with
         this number each time. Newest WHATSAPP_THREAD_MAX first, then flipped back to
         oldest-first, which is the order the thread renders in. */
      const { data, error } = await supabase
        .from("whatsapp_messages")
        .select("*")
        .eq("contact_phone", contactPhone!)
        .order("created_at", { ascending: false })
        .limit(WHATSAPP_THREAD_MAX);
      if (error) throw error;
      return ((data ?? []) as WhatsAppMessageRow[]).reverse();
    },
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

interface SendInput {
  to:   string;
  text?: string;
  template?: { name: string; language: string; components?: unknown[] };
  /** Quote ID to render PDF for + attach to the message. Server renders
   *  the PDF, uploads to Meta /media, then sends type=document with the
   *  text becoming the caption. */
  attach_quote_id?: string;
  related?: { leadId?: string; quoteId?: string; customerId?: string };
}

export function useSendWhatsApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SendInput) => {
      const res  = await fetch("/api/whatsapp/send", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(input),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Send failed");
      return json as { wamid: string | null; status: string };
    },
    onSuccess: () => {
      toast.success("WhatsApp message sent");
      qc.invalidateQueries({ queryKey: ["whatsapp"] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
