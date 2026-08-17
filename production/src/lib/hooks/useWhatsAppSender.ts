/**
 * The tenant identity that goes on an outbound WhatsApp message.
 *
 * Exists as a hook rather than a prop because the three WhatsApp buttons on
 * /invoices live in three different components — the bulk bar, the row menu and the
 * detail sheet — and threading a sender through all of them is the prop drilling
 * CLAUDE.md §8 warns about. It also means a NEW WhatsApp button cannot be added
 * without a sender: there is no zero-argument way to build the message any more.
 *
 * `useCurrentUser` is already cached by TanStack Query, so every caller shares one
 * fetch.
 *
 * Returns `null` while the identity is unknown. lib/whatsapp.ts then leaves the
 * message unsigned and omits the pay link, which is the honest degradation — see the
 * header there for why no name beats the wrong name.
 */
"use client";

import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import type { WhatsAppSender } from "@/lib/whatsapp";

export function useWhatsAppSender(): WhatsAppSender | null {
  const { data: me } = useCurrentUser();
  if (!me) return null;
  return {
    businessName: me.tenantName,
    upiVpa:       me.tenantUpiVpa,
    upiPayeeName: me.tenantUpiPayeeName,
  };
}
